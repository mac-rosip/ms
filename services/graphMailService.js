const axios = require('axios');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

class GraphMailService {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async getProfile() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me`, { headers: this.headers });
    return response.data;
  }

  async getFolders() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/mailFolders?$top=100`, { headers: this.headers });
    return response.data.value;
  }

  async getFolder(folderId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/mailFolders/${folderId}`, { headers: this.headers });
    return response.data;
  }

  async getMessages(options = {}) {
    const {
      folderId = 'inbox',
      top = 25,
      skip = 0,
      filter = null,
      search = null,
      orderBy = 'receivedDateTime desc',
      select = 'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,importance,flag,conversationId,parentFolderId'
    } = options;

    let url = `${GRAPH_BASE_URL}/me/mailFolders/${folderId}/messages?`;
    const params = new URLSearchParams();
    params.append('$top', top);
    params.append('$skip', skip);
    params.append('$select', select);
    params.append('$orderby', orderBy);
    if (filter) params.append('$filter', filter);
    if (search) params.append('$search', `"${search}"`);
    url += params.toString();

    const response = await axios.get(url, { headers: this.headers });
    return {
      messages: response.data.value,
      nextLink: response.data['@odata.nextLink'] || null,
      count: response.data['@odata.count'] || response.data.value.length
    };
  }

  async searchMessages(query, options = {}) {
    const { top = 25, skip = 0 } = options;
    const url = `${GRAPH_BASE_URL}/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$skip=${skip}&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,hasAttachments,importance,parentFolderId`;
    const response = await axios.get(url, { headers: this.headers });
    return { messages: response.data.value, nextLink: response.data['@odata.nextLink'] || null };
  }

  async getMessage(messageId) {
    const response = await axios.get(
      `${GRAPH_BASE_URL}/me/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,sentDateTime,isRead,hasAttachments,importance,flag,conversationId,parentFolderId`,
      { headers: this.headers }
    );
    return response.data;
  }

  async getAttachments(messageId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/messages/${messageId}/attachments`, { headers: this.headers });
    return response.data.value;
  }

  async getAttachment(messageId, attachmentId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/messages/${messageId}/attachments/${attachmentId}`, { headers: this.headers });
    return response.data;
  }

  async setReadStatus(messageId, isRead) {
    const response = await axios.patch(`${GRAPH_BASE_URL}/me/messages/${messageId}`, { isRead }, { headers: this.headers });
    return response.data;
  }

  async bulkSetReadStatus(messageIds, isRead) {
    const results = await Promise.allSettled(messageIds.map(id => this.setReadStatus(id, isRead)));
    return results.map((r, i) => ({
      messageId: messageIds[i],
      success: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason.message : null
    }));
  }

  async moveMessage(messageId, destinationFolderId) {
    const response = await axios.post(`${GRAPH_BASE_URL}/me/messages/${messageId}/move`, { destinationId: destinationFolderId }, { headers: this.headers });
    return response.data;
  }

  async deleteMessage(messageId) {
    await axios.delete(`${GRAPH_BASE_URL}/me/messages/${messageId}`, { headers: this.headers });
    return { success: true };
  }

  async bulkDeleteMessages(messageIds) {
    const results = await Promise.allSettled(messageIds.map(id => this.deleteMessage(id)));
    return results.map((r, i) => ({
      messageId: messageIds[i],
      success: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason.message : null
    }));
  }

  async sendMessage(message) {
    await axios.post(`${GRAPH_BASE_URL}/me/sendMail`, { message: this._formatMessage(message), saveToSentItems: true }, { headers: this.headers });
    return { success: true };
  }

  async reply(messageId, comment, replyAll = false) {
    const endpoint = replyAll ? 'replyAll' : 'reply';
    await axios.post(`${GRAPH_BASE_URL}/me/messages/${messageId}/${endpoint}`, { comment }, { headers: this.headers });
    return { success: true };
  }

  async forward(messageId, toRecipients, comment = '') {
    await axios.post(`${GRAPH_BASE_URL}/me/messages/${messageId}/forward`, {
      comment,
      toRecipients: toRecipients.map(email => ({ emailAddress: { address: email } }))
    }, { headers: this.headers });
    return { success: true };
  }

  async getInboxStats() {
    const [inbox, drafts, sentItems, junkEmail] = await Promise.all([
      this.getFolder('inbox'),
      this.getFolder('drafts'),
      this.getFolder('sentitems'),
      this.getFolder('junkemail')
    ]);
    return {
      inbox: { total: inbox.totalItemCount, unread: inbox.unreadItemCount },
      drafts: { total: drafts.totalItemCount },
      sent: { total: sentItems.totalItemCount },
      junk: { total: junkEmail.totalItemCount, unread: junkEmail.unreadItemCount }
    };
  }

  _formatMessage(message) {
    const formatted = {};
    if (message.subject) formatted.subject = message.subject;
    if (message.body) formatted.body = { contentType: message.bodyType || 'HTML', content: message.body };
    if (message.to) formatted.toRecipients = this._formatRecipients(message.to);
    if (message.cc) formatted.ccRecipients = this._formatRecipients(message.cc);
    if (message.bcc) formatted.bccRecipients = this._formatRecipients(message.bcc);
    if (message.importance) formatted.importance = message.importance;
    return formatted;
  }

  _formatRecipients(recipients) {
    if (typeof recipients === 'string') recipients = recipients.split(',').map(e => e.trim());
    return recipients.map(email => ({ emailAddress: { address: email } }));
  }
}

  // === ONEDRIVE METHODS ===

  async getDriveInfo() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive`, { headers: this.headers });
    return response.data;
  }

  async getDriveRoot() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/root?$expand=children`, { headers: this.headers });
    return response.data;
  }

  async getDriveItem(itemId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/items/${itemId}?$expand=children`, { headers: this.headers });
    return response.data;
  }

  async getDriveItemByPath(path) {
    const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/');
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/root:${encodedPath}?$expand=children`, { headers: this.headers });
    return response.data;
  }

  async getDriveChildren(itemId = 'root') {
    const endpoint = itemId === 'root'
      ? `${GRAPH_BASE_URL}/me/drive/root/children`
      : `${GRAPH_BASE_URL}/me/drive/items/${itemId}/children`;
    const response = await axios.get(`${endpoint}?$top=100&$orderby=name`, { headers: this.headers });
    return response.data.value;
  }

  async searchDrive(query) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/root/search(q='${encodeURIComponent(query)}')`, { headers: this.headers });
    return response.data.value;
  }

  async getDriveItemContent(itemId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/items/${itemId}/content`, {
      headers: this.headers,
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });

    // If redirect, return the download URL
    if (response.status === 302) {
      return { redirectUrl: response.headers.location };
    }
    return { content: response.data, contentType: response.headers['content-type'] };
  }

  async getDriveDownloadUrl(itemId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/items/${itemId}?select=@microsoft.graph.downloadUrl`, { headers: this.headers });
    return response.data['@microsoft.graph.downloadUrl'];
  }

  async getRecentFiles() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/recent?$top=25`, { headers: this.headers });
    return response.data.value;
  }

  async getSharedWithMe() {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/sharedWithMe?$top=25`, { headers: this.headers });
    return response.data.value;
  }

  async createFolder(parentId, folderName) {
    const endpoint = parentId === 'root'
      ? `${GRAPH_BASE_URL}/me/drive/root/children`
      : `${GRAPH_BASE_URL}/me/drive/items/${parentId}/children`;
    const response = await axios.post(endpoint, {
      name: folderName,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'rename'
    }, { headers: this.headers });
    return response.data;
  }

  async deleteItem(itemId) {
    await axios.delete(`${GRAPH_BASE_URL}/me/drive/items/${itemId}`, { headers: this.headers });
    return { success: true };
  }

  async renameItem(itemId, newName) {
    const response = await axios.patch(`${GRAPH_BASE_URL}/me/drive/items/${itemId}`, { name: newName }, { headers: this.headers });
    return response.data;
  }

  async copyItem(itemId, destinationParentId, newName = null) {
    const body = {
      parentReference: { id: destinationParentId }
    };
    if (newName) body.name = newName;

    const response = await axios.post(`${GRAPH_BASE_URL}/me/drive/items/${itemId}/copy`, body, { headers: this.headers });
    return response.data;
  }

  async moveItem(itemId, destinationParentId) {
    const response = await axios.patch(`${GRAPH_BASE_URL}/me/drive/items/${itemId}`, {
      parentReference: { id: destinationParentId }
    }, { headers: this.headers });
    return response.data;
  }

  async getThumbnails(itemId) {
    const response = await axios.get(`${GRAPH_BASE_URL}/me/drive/items/${itemId}/thumbnails`, { headers: this.headers });
    return response.data.value;
  }
}

module.exports = GraphMailService;
