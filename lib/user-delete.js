import { deleteUser, getUserById } from './db-store.js';
import { deleteFile, getFileByLinkedUserId } from './files.js';

export async function deleteUserWithData(userId) {
  const user = await getUserById(userId);
  if (!user) return null;

  const file = await getFileByLinkedUserId(userId);
  let fileDelete = null;
  if (file) {
    fileDelete = await deleteFile(file.id);
  }

  await deleteUser(userId);

  return {
    ok: true,
    userId,
    userName: user.name,
    uuid: user.uuid,
    fileDeleted: Boolean(fileDelete),
    storage: fileDelete?.storage || null,
  };
}
