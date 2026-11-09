const Notification = require('../models/Notification');
const User = require('../models/User');
const firebaseApp = require('../firebase');

/**
 * Creates in-app notifications and attempts to send push notifications via Firebase FCM
 * or Expo Push API if pushTokens are present on the recipients.
 *
 * @param {Array<{
 *   recipient: string|mongoose.Types.ObjectId,
 *   sender?: string|mongoose.Types.ObjectId|null,
 *   type: string,
 *   title: string,
 *   body: string,
 *   data?: Record<string, any>
 * }>} notifications
 */
async function sendNotifications(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return [];
  }

  try {
    // 1. Insert in-app notifications in MongoDB
    const createdDocs = await Notification.insertMany(notifications, { ordered: false });

    // 2. Fetch push tokens for recipients to attempt push delivery
    const recipientIds = [...new Set(notifications.map((n) => n.recipient.toString()))];
    const usersWithTokens = await User.find({
      _id: { $in: recipientIds },
      pushToken: { $exists: true, $ne: '' },
    })
      .select('_id pushToken')
      .lean();

    if (usersWithTokens.length > 0) {
      const tokenMap = new Map(usersWithTokens.map((u) => [u._id.toString(), u.pushToken]));

      // Separate into Expo push tokens and raw FCM tokens
      const expoPushMessages = [];
      const fcmTokens = [];

      for (const notif of notifications) {
        const token = tokenMap.get(notif.recipient.toString());
        if (!token) continue;

        if (token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken')) {
          expoPushMessages.push({
            to: token,
            sound: 'default',
            title: notif.title,
            body: notif.body,
            data: notif.data || {},
          });
        } else {
          fcmTokens.push({
            token,
            title: notif.title,
            body: notif.body,
            data: notif.data || {},
          });
        }
      }

      // Send to Expo Push Service if applicable
      if (expoPushMessages.length > 0) {
        try {
          await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Accept-encoding': 'gzip, deflate',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(expoPushMessages),
          });
        } catch (expoErr) {
          console.warn('[NotificationService] Expo push failed:', expoErr.message);
        }
      }

      // Send via Firebase Admin if configured and tokens exist
      if (fcmTokens.length > 0 && firebaseApp) {
        try {
          const messaging = firebaseApp.messaging ? firebaseApp.messaging() : null;
          if (messaging) {
            for (const item of fcmTokens) {
              await messaging.send({
                token: item.token,
                notification: {
                  title: item.title,
                  body: item.body,
                },
                data: Object.fromEntries(
                  Object.entries(item.data || {}).map(([k, v]) => [k, String(v)])
                ),
              });
            }
          }
        } catch (fcmErr) {
          console.warn('[NotificationService] FCM push failed:', fcmErr.message);
        }
      }
    }

    return createdDocs;
  } catch (error) {
    console.error('[NotificationService] Erreur lors de la création des notifications:', error);
    return [];
  }
}

module.exports = {
  sendNotifications,
};

