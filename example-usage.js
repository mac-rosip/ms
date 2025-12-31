/**
 * Example: How to generate magic links and send them to users
 * 
 * This demonstrates the backend flow for creating authorization links
 * that your users can click to automatically authorize.
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:3000'; // Change to your Render URL in production

/**
 * Example 1: Generate magic link for a user
 */
async function generateMagicLinkForUser(userId, userEmail) {
  try {
    const response = await axios.post(`${SERVER_URL}/auth/magic-link`, {
      userId: userId,
      userEmail: userEmail,
      metadata: {
        // Optional: Add any metadata you want to track
        signupDate: new Date().toISOString(),
        source: 'web-app',
        plan: 'premium'
      }
    });

    const { magicLink, expiresIn } = response.data;
    
    console.log('✅ Magic link generated!');
    console.log('Link:', magicLink);
    console.log(`Expires in: ${expiresIn} seconds`);
    
    return magicLink;
  } catch (error) {
    console.error('Failed to generate magic link:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Example 2: Send magic link via email (pseudo-code)
 */
async function sendAuthLinkToUser(userId, userEmail) {
  // Generate the link
  const magicLink = await generateMagicLinkForUser(userId, userEmail);
  
  // Send via your email service (SendGrid, Mailgun, etc.)
  // This is pseudo-code - replace with your actual email service
  /*
  await emailService.send({
    to: userEmail,
    subject: 'Connect Your Microsoft Account',
    html: `
      <h2>Connect Your Microsoft Account</h2>
      <p>Click the link below to securely connect your Microsoft account:</p>
      <a href="${magicLink}">Authorize Microsoft Access</a>
      <p>This link expires in 10 minutes.</p>
    `
  });
  */
  
  console.log(`📧 Email would be sent to: ${userEmail}`);
  console.log(`📎 Link: ${magicLink}`);
}

/**
 * Example 3: Batch generate links for multiple users
 */
async function generateLinksForMultipleUsers(users) {
  const links = [];
  
  for (const user of users) {
    try {
      const link = await generateMagicLinkForUser(user.id, user.email);
      links.push({
        userId: user.id,
        email: user.email,
        link: link
      });
      console.log(`✓ Link generated for ${user.email}`);
    } catch (error) {
      console.error(`✗ Failed for ${user.email}:`, error.message);
    }
  }
  
  return links;
}

/**
 * Example 4: Generate link and display QR code (for mobile)
 */
async function generateQRCodeLink(userId, userEmail) {
  const magicLink = await generateMagicLinkForUser(userId, userEmail);
  
  // Generate QR code using a library like 'qrcode'
  // const QRCode = require('qrcode');
  // const qrCodeDataURL = await QRCode.toDataURL(magicLink);
  
  console.log('📱 QR Code can be generated from this link:', magicLink);
  // return qrCodeDataURL;
}

// Run examples
async function main() {
  console.log('=== Magic Link Examples ===\n');
  
  // Example 1: Single user
  console.log('Example 1: Generate magic link for single user');
  await generateMagicLinkForUser('user123', 'user@example.com');
  console.log('\n---\n');
  
  // Example 2: Send via email
  console.log('Example 2: Send magic link via email');
  await sendAuthLinkToUser('user456', 'another@example.com');
  console.log('\n---\n');
  
  // Example 3: Batch generation
  console.log('Example 3: Generate links for multiple users');
  const users = [
    { id: 'user001', email: 'alice@example.com' },
    { id: 'user002', email: 'bob@example.com' },
    { id: 'user003', email: 'charlie@example.com' }
  ];
  const links = await generateLinksForMultipleUsers(users);
  console.log('\nGenerated links:', links);
  console.log('\n---\n');
  
  // Example 4: QR Code
  console.log('Example 4: Generate QR code link');
  await generateQRCodeLink('user789', 'mobile@example.com');
}

// Uncomment to run examples:
// main().catch(console.error);

module.exports = {
  generateMagicLinkForUser,
  sendAuthLinkToUser,
  generateLinksForMultipleUsers,
  generateQRCodeLink
};
