/** Имя объекта в bucket — максимально похоже на рабочий subscription.txt */
export function userSubscriptionObjectName(userId) {
  return `subscription-${String(userId || '').toLowerCase()}.txt`;
}
