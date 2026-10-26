const MAILBOX = 'mail@merosplit.com';

export default {
  async email(message, env) {
    if (message.to.toLowerCase() !== MAILBOX) {
      message.setReject('Unknown recipient');
      return;
    }
    if (!env?.FORWARD_TO) throw new Error('Mail forwarding is not configured');
    await message.forward(env.FORWARD_TO);
  },
};
