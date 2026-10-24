export function accountDeletionInput(confirmation: string, email: string, currentEmail: string): { confirmation: 'delete'; email: string } {
  if (confirmation !== 'delete' || email.trim().toLowerCase() !== currentEmail.trim().toLowerCase()) throw new Error('Type delete and enter your current account email.');
  return { confirmation: 'delete', email: email.trim() };
}
