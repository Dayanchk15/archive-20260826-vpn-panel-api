<?php
declare(strict_types=1);

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Hostinger proxy: create config.php from config.php.example\n";
    exit;
}

$config = require $configFile;
$upstream = rtrim((string) ($config['upstream'] ?? ''), '/');
if ($upstream === '') {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Hostinger proxy: set upstream in config.php\n";
    exit;
}

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$query = $_SERVER['QUERY_STRING'] ?? '';
$targetPath = $uri;

// Subscription/status endpoints plus the DADA VPN and DADA Connect mobile API aliases.
$isSubscriptionPath = preg_match('#^/(api/)?(sub|status)(/|$)#', $targetPath) === 1;
$isShortLinkPath = preg_match('#^/f/#', $targetPath) === 1;
$isMobileApiPath = preg_match('#^/api/mobile/v1(?:/|$)#', $targetPath) === 1;
if (!$isSubscriptionPath && !$isShortLinkPath && !$isMobileApiPath) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found\n";
    exit;
}

$target = $upstream . $targetPath . ($query !== '' ? '?' . $query : '');

$upstreamHost = trim((string) ($config['upstream_host'] ?? ''));
$forwardHeaders = [];
if ($upstreamHost !== '') {
    $forwardHeaders[] = 'host: ' . $upstreamHost;
}
$skipRequestHeaders = ['host', 'connection', 'content-length', 'accept-encoding'];
$hasAuthorizationHeader = false;
foreach ($_SERVER as $key => $value) {
    if (strpos($key, 'HTTP_') !== 0) {
        continue;
    }
    $name = strtolower(str_replace('_', '-', substr($key, 5)));
    if (in_array($name, $skipRequestHeaders, true)) {
        continue;
    }
    if ($name === 'authorization') {
        $hasAuthorizationHeader = true;
    }
    $forwardHeaders[] = $name . ': ' . $value;
}
if (!empty($_SERVER['CONTENT_TYPE'])) {
    $forwardHeaders[] = 'content-type: ' . $_SERVER['CONTENT_TYPE'];
}
if (!$hasAuthorizationHeader) {
    $authorization = (string) ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($authorization !== '') {
        $forwardHeaders[] = 'authorization: ' . $authorization;
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = file_get_contents('php://input');

$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_HTTPHEADER => $forwardHeaders,
    CURLOPT_POSTFIELDS => $method === 'GET' || $method === 'HEAD' ? null : $body,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => $upstreamHost !== '' ? 0 : 2,
]);

$response = curl_exec($ch);
if ($response === false) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Upstream error: ' . curl_error($ch) . "\n";
    curl_close($ch);
    exit;
}

$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeaders = substr($response, 0, $headerSize);
$bodyOut = substr($response, $headerSize);

$passHeaders = [
    'content-type',
    'content-disposition',
    'cache-control',
    'etag',
    'last-modified',
    'retry-after',
    'www-authenticate',
    'subscription-userinfo',
    'profile-title',
    'profile-update-interval',
    'profile-web-page-url',
    'support-url',
    'sub-info-text',
    'sub-info-color',
    'announce',
    'hide-settings',
    'new-url',
    'providerid',
    'access-control-expose-headers',
    'fragmentation-enable',
    'fragmentation-packets',
    'fragmentation-length',
    'fragmentation-interval',
    'fragmentation-maxsplit',
];

http_response_code($status);
foreach (preg_split("/\r\n|\n|\r/", $rawHeaders) as $line) {
    if ($line === '' || strpos($line, ':') === false) {
        continue;
    }
    [$name, $value] = explode(':', $line, 2);
    $name = strtolower(trim($name));
    $value = trim($value);
    if (in_array($name, $passHeaders, true)) {
        header($name . ': ' . $value, false);
    }
}

echo $bodyOut;
