const MAILBOX = 'mail@merosplit.com';
const DESTINATION = 'mail@merosplit.com';

export default {
  async email(message) {
    if (message.to.toLowerCase() !== MAILBOX) {
      message.setReject('Unknown recipient');
      return;
    }
    await message.forward(DESTINATION);
  },
};
