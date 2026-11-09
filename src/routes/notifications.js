const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/notifications — Retrieve the current user's notifications + unread count
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ recipient: req.userDB._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('sender', 'name pseudo photo')
        .lean(),
      Notification.countDocuments({ recipient: req.userDB._id, isRead: false }),
    ]);

    const formatted = notifications.map((n) => ({
      id: n._id.toString(),
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data || {},
      isRead: n.isRead,
      createdAt: n.createdAt,
      sender: n.sender
        ? {
            id: n.sender._id.toString(),
            name: n.sender.name || n.sender.pseudo || 'Coureur',
            photo: n.sender.photo || null,
          }
        : null,
    }));

    return res.status(200).json({
      notifications: formatted,
      unreadCount,
    });
  } catch (error) {
    console.error('Erreur GET /api/notifications:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération des notifications.' });
  }
});

// PATCH /api/notifications/mark-read — Mark all or specific notifications as read
router.patch('/mark-read', authenticateToken, async (req, res) => {
  try {
    const { notificationIds, all } = req.body || {};

    if (all) {
      await Notification.updateMany(
        { recipient: req.userDB._id, isRead: false },
        { $set: { isRead: true } }
      );
    } else if (Array.isArray(notificationIds) && notificationIds.length > 0) {
      const validIds = notificationIds.filter(isValidId);
      await Notification.updateMany(
        { _id: { $in: validIds }, recipient: req.userDB._id },
        { $set: { isRead: true } }
      );
    }

    const unreadCount = await Notification.countDocuments({
      recipient: req.userDB._id,
      isRead: false,
    });

    return res.status(200).json({ ok: true, unreadCount });
  } catch (error) {
    console.error('Erreur PATCH /api/notifications/mark-read:', error);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour des notifications.' });
  }
});

// POST /api/notifications/push-token — Register or update device push token
router.post('/push-token', authenticateToken, async (req, res) => {
  try {
    const pushToken = typeof req.body?.pushToken === 'string' ? req.body.pushToken.trim() : '';
    await User.updateOne({ _id: req.userDB._id }, { $set: { pushToken } });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Erreur POST /api/notifications/push-token:', error);
    return res.status(500).json({ error: "Erreur lors de l'enregistrement du token push." });
  }
});

module.exports = router;

