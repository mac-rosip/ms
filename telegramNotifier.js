const TelegramBot = require('node-telegram-bot-api');

class TelegramNotifier {
  constructor(botToken, chatId) {
    this.chatId = chatId;
    
    if (!botToken || !chatId) {
      console.warn('⚠️  Telegram credentials not configured. Notifications will be logged only.');
      this.bot = null;
      return;
    }

    try {
      this.bot = new TelegramBot(botToken, { polling: false });
      console.log('✓ Telegram notifier initialized');
    } catch (error) {
      console.error('Failed to initialize Telegram bot:', error.message);
      this.bot = null;
    }
  }

  async sendMessage(message) {
    console.log('[Telegram Notification]:', message);
    
    if (!this.bot || !this.chatId) {
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
      console.log('✓ Telegram message sent');
    } catch (error) {
      console.error('Failed to send Telegram message:', error.message);
    }
  }

  async sendDocument(filePath, caption = '') {
    if (!this.bot || !this.chatId) {
      console.log('[Telegram] Would send document:', filePath);
      return;
    }

    try {
      await this.bot.sendDocument(this.chatId, filePath, { caption });
      console.log('✓ Telegram document sent');
    } catch (error) {
      console.error('Failed to send Telegram document:', error.message);
    }
  }
}

module.exports = TelegramNotifier;
