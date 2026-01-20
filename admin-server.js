require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const GraphMailService = require('./services/graphMailService');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

// Main OAuth server URL (where tokens are stored)
const OAUTH_SERVER_URL = process.env.OAUTH_SERVER_URL || 'http://localhost:3000';

// Token cache (in-memory, refreshed on demand)
const tokenCache = new Map();

// Fetch token from main server
async function fetchToken(userId) {
  try {
    const response = await axios.get(`${OAUTH_SERVER_URL}/auth/token/${userId}/full`);
    const token = response.data;
    tokenCache.set(userId, token);
    return token;
  } catch (error) {
    console.error(`Failed to fetch token for ${userId}:`, error.message);
    return null;
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve admin inbox GUI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-inbox.html'));
});

// Get all tokens (proxy to main server)
app.get('/tokens', async (req, res) => {
  try {
    const response = await axios.get(`${OAUTH_SERVER_URL}/tokens`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tokens from OAuth server' });
  }
});

// Refresh token (proxy to main server)
app.post('/auth/refresh', async (req, res) => {
  try {
    const response = await axios.post(`${OAUTH_SERVER_URL}/auth/refresh`, req.body);
    // Clear cache so next request gets fresh token
    if (req.body.userId) {
      tokenCache.delete(req.body.userId);
    }
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// Middleware to get mail service for a user
const withMailService = async (req, res, next) => {
  const userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    // Check cache first, then fetch
    let token = tokenCache.get(userId);
    if (!token || new Date(token.expiresAt) <= new Date()) {
      token = await fetchToken(userId);
    }

    if (!token) {
      return res.status(404).json({ error: `No token found for user: ${userId}` });
    }

    const expiresAt = new Date(token.expiresAt).getTime();
    if (expiresAt <= Date.now()) {
      return res.status(401).json({ error: 'Token expired', needsRefresh: true });
    }

    req.userId = userId;
    req.token = token;
    req.mailService = new GraphMailService(token.access_token);
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to initialize mail service' });
  }
};

// Error handler for Graph API
function handleGraphError(error, res) {
  console.error('Graph API error:', error.response?.data || error.message);
  const status = error.response?.status || 500;
  const graphError = error.response?.data?.error;

  res.status(status).json({
    error: graphError?.message || error.message,
    code: graphError?.code || 'UnknownError',
    needsRefresh: status === 401
  });
}

// === INBOX API ROUTES ===

// Get user profile
app.get('/inbox/:userId/profile', withMailService, async (req, res) => {
  try {
    const profile = await req.mailService.getProfile();
    res.json(profile);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get inbox stats
app.get('/inbox/:userId/stats', withMailService, async (req, res) => {
  try {
    const stats = await req.mailService.getInboxStats();
    res.json(stats);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get all folders
app.get('/inbox/:userId/folders', withMailService, async (req, res) => {
  try {
    const folders = await req.mailService.getFolders();
    res.json(folders);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get messages from folder
app.get('/inbox/:userId/folders/:folderId/messages', withMailService, async (req, res) => {
  try {
    const { top = 25, skip = 0, filter, search, orderBy } = req.query;
    const result = await req.mailService.getMessages({
      folderId: req.params.folderId,
      top: parseInt(top),
      skip: parseInt(skip),
      filter,
      search,
      orderBy
    });
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Search messages
app.get('/inbox/:userId/search', withMailService, async (req, res) => {
  try {
    const { q, top = 25, skip = 0 } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query (q) is required' });
    }
    const result = await req.mailService.searchMessages(q, {
      top: parseInt(top),
      skip: parseInt(skip)
    });
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get single message
app.get('/inbox/:userId/messages/:messageId', withMailService, async (req, res) => {
  try {
    const message = await req.mailService.getMessage(req.params.messageId);
    res.json(message);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get attachments
app.get('/inbox/:userId/messages/:messageId/attachments', withMailService, async (req, res) => {
  try {
    const attachments = await req.mailService.getAttachments(req.params.messageId);
    res.json(attachments);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Download attachment
app.get('/inbox/:userId/messages/:messageId/attachments/:attachmentId/download', withMailService, async (req, res) => {
  try {
    const attachment = await req.mailService.getAttachment(req.params.messageId, req.params.attachmentId);
    if (attachment.contentBytes) {
      const buffer = Buffer.from(attachment.contentBytes, 'base64');
      res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${attachment.name}"`);
      res.send(buffer);
    } else {
      res.status(404).json({ error: 'Attachment content not available' });
    }
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Mark read/unread
app.patch('/inbox/:userId/messages/:messageId/read', withMailService, async (req, res) => {
  try {
    const { isRead = true } = req.body;
    const result = await req.mailService.setReadStatus(req.params.messageId, isRead);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Bulk mark read/unread
app.patch('/inbox/:userId/messages/bulk/read', withMailService, async (req, res) => {
  try {
    const { messageIds, isRead = true } = req.body;
    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ error: 'messageIds array is required' });
    }
    const results = await req.mailService.bulkSetReadStatus(messageIds, isRead);
    res.json(results);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Move message
app.post('/inbox/:userId/messages/:messageId/move', withMailService, async (req, res) => {
  try {
    const { destinationFolderId } = req.body;
    if (!destinationFolderId) {
      return res.status(400).json({ error: 'destinationFolderId is required' });
    }
    const result = await req.mailService.moveMessage(req.params.messageId, destinationFolderId);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Delete message
app.delete('/inbox/:userId/messages/:messageId', withMailService, async (req, res) => {
  try {
    const result = await req.mailService.deleteMessage(req.params.messageId);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Bulk delete
app.delete('/inbox/:userId/messages/bulk', withMailService, async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ error: 'messageIds array is required' });
    }
    const results = await req.mailService.bulkDeleteMessages(messageIds);
    res.json(results);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Send message
app.post('/inbox/:userId/send', withMailService, async (req, res) => {
  try {
    const result = await req.mailService.sendMessage(req.body);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Reply
app.post('/inbox/:userId/messages/:messageId/reply', withMailService, async (req, res) => {
  try {
    const { comment, replyAll = false } = req.body;
    if (!comment) {
      return res.status(400).json({ error: 'comment is required' });
    }
    const result = await req.mailService.reply(req.params.messageId, comment, replyAll);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Forward
app.post('/inbox/:userId/messages/:messageId/forward', withMailService, async (req, res) => {
  try {
    const { to, comment = '' } = req.body;
    if (!to) {
      return res.status(400).json({ error: 'to recipients required' });
    }
    const recipients = Array.isArray(to) ? to : [to];
    const result = await req.mailService.forward(req.params.messageId, recipients, comment);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// === ONEDRIVE API ROUTES ===

// Get drive info
app.get('/drive/:userId/info', withMailService, async (req, res) => {
  try {
    const info = await req.mailService.getDriveInfo();
    res.json(info);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get root folder
app.get('/drive/:userId/root', withMailService, async (req, res) => {
  try {
    const root = await req.mailService.getDriveRoot();
    res.json(root);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get folder children
app.get('/drive/:userId/items/:itemId/children', withMailService, async (req, res) => {
  try {
    const children = await req.mailService.getDriveChildren(req.params.itemId);
    res.json(children);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get item details
app.get('/drive/:userId/items/:itemId', withMailService, async (req, res) => {
  try {
    const item = await req.mailService.getDriveItem(req.params.itemId);
    res.json(item);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Search files
app.get('/drive/:userId/search', withMailService, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query (q) required' });
    const results = await req.mailService.searchDrive(q);
    res.json(results);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get recent files
app.get('/drive/:userId/recent', withMailService, async (req, res) => {
  try {
    const files = await req.mailService.getRecentFiles();
    res.json(files);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get shared with me
app.get('/drive/:userId/shared', withMailService, async (req, res) => {
  try {
    const files = await req.mailService.getSharedWithMe();
    res.json(files);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Download file
app.get('/drive/:userId/items/:itemId/download', withMailService, async (req, res) => {
  try {
    const downloadUrl = await req.mailService.getDriveDownloadUrl(req.params.itemId);
    res.redirect(downloadUrl);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Get thumbnails
app.get('/drive/:userId/items/:itemId/thumbnails', withMailService, async (req, res) => {
  try {
    const thumbnails = await req.mailService.getThumbnails(req.params.itemId);
    res.json(thumbnails);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Create folder
app.post('/drive/:userId/items/:parentId/folder', withMailService, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name required' });
    const folder = await req.mailService.createFolder(req.params.parentId, name);
    res.json(folder);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Delete item
app.delete('/drive/:userId/items/:itemId', withMailService, async (req, res) => {
  try {
    const result = await req.mailService.deleteItem(req.params.itemId);
    res.json(result);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Rename item
app.patch('/drive/:userId/items/:itemId/rename', withMailService, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'New name required' });
    const item = await req.mailService.renameItem(req.params.itemId, name);
    res.json(item);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Move item
app.post('/drive/:userId/items/:itemId/move', withMailService, async (req, res) => {
  try {
    const { destinationId } = req.body;
    if (!destinationId) return res.status(400).json({ error: 'Destination folder ID required' });
    const item = await req.mailService.moveItem(req.params.itemId, destinationId);
    res.json(item);
  } catch (error) {
    handleGraphError(error, res);
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`\n📬 Admin Inbox Server running on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log(`   OAuth Server: ${OAUTH_SERVER_URL}\n`);

  // Test connection to OAuth server
  try {
    const response = await axios.get(`${OAUTH_SERVER_URL}/tokens`);
    console.log(`✅ Connected to OAuth server`);
    console.log(`   ${response.data.count || 0} token(s) available\n`);
  } catch (error) {
    console.error(`⚠️  Could not connect to OAuth server at ${OAUTH_SERVER_URL}`);
    console.error(`   Make sure it's running and accessible\n`);
  }
});
