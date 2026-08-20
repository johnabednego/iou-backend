// services/reminderService.js
// Sends 24-hour recurring reminders for IOUs that have been disbursed
// but the requester has not yet submitted an expense report.

const { Op } = require('sequelize');
const IOURequest = require('../models/IOURequest');
const ExpenseSubmission = require('../models/ExpenseSubmission');
const Approval = require('../models/Approval');
const Notification = require('../models/Notification');
const User = require('../models/User');
const notificationService = require('./notificationService');

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REMINDER_ENTITY = 'EXPENSE_REMINDER';

/**
 * Check for IOUs awaiting expense submission and send reminders
 * if 24+ hours have passed since the last reminder (or since disbursement).
 */
async function checkAndSendExpenseReminders() {
  try {
    // Find IOUs that are DISBURSED or DISBURSEMENT_CONFIRMED
    const pendingIOUs = await IOURequest.findAll({
      where: {
        status: { [Op.in]: ['DISBURSED', 'DISBURSEMENT_CONFIRMED'] }
      },
      include: [
        {
          model: User,
          as: 'requester',
          attributes: ['id', 'display_name', 'username', 'email']
        }
      ]
    });

    if (pendingIOUs.length === 0) return;

    let remindersSent = 0;

    for (const iou of pendingIOUs) {
      try {
        // Check if an expense submission already exists for this IOU
        const existingExpense = await ExpenseSubmission.findOne({
          where: { iou_id: iou.id }
        });

        // If expense already submitted, skip
        if (existingExpense) continue;

        // Check when the last reminder was sent for this IOU
        const lastReminder = await Notification.findOne({
          where: {
            entity: REMINDER_ENTITY,
            entity_id: iou.id
          },
          order: [['created_at', 'DESC']]
        });

        const now = new Date();
        let shouldSend = false;

        if (!lastReminder) {
          // No reminder ever sent — check if 24h since IOU was disbursed (updated_at)
          const disbursedAt = new Date(iou.updated_at || iou.created_at);
          if (now - disbursedAt >= REMINDER_INTERVAL_MS) {
            shouldSend = true;
          }
        } else {
          // Check if 24h since last reminder
          const lastSentAt = new Date(lastReminder.created_at);
          if (now - lastSentAt >= REMINDER_INTERVAL_MS) {
            shouldSend = true;
          }
        }

        if (!shouldSend) continue;

        const requesterName = iou.requester?.display_name || iou.requester?.username || 'Unknown';
        const iouRef = iou.request_number || iou.id;

        // 1. Send reminder to the REQUESTER
        await notificationService.createAndSendEmail({
          target_user_id: iou.requester_id,
          title: `Expense Report Overdue: ${iouRef}`,
          body: `Your IOU ${iouRef} was disbursed but you have not yet submitted your expense report with receipts. Please submit your expense report as soon as possible.`,
          link: `/ious/${iou.id}`,
          entity: REMINDER_ENTITY,
          entity_id: iou.id
        });

        // 2. Find the HOD/approver(s) who approved this IOU and notify them
        const approvals = await Approval.findAll({
          where: {
            iou_id: iou.id,
            decision: 'APPROVED'
          },
          include: [
            { model: User, as: 'approver', attributes: ['id', 'display_name', 'username', 'email'] }
          ]
        });

        const notifiedApproverIds = new Set();
        for (const approval of approvals) {
          if (!approval.approver_id || notifiedApproverIds.has(approval.approver_id)) continue;
          // Don't notify the requester again if they happen to be an approver
          if (approval.approver_id === iou.requester_id) continue;

          notifiedApproverIds.add(approval.approver_id);

          await notificationService.createAndSendEmail({
            target_user_id: approval.approver_id,
            title: `Expense Report Pending: ${iouRef}`,
            body: `${requesterName} has not yet submitted their expense report for IOU ${iouRef}. The funds were disbursed but no expense receipts have been provided.`,
            link: `/ious/${iou.id}`,
            entity: REMINDER_ENTITY,
            entity_id: iou.id
          });
        }

        remindersSent++;
      } catch (err) {
        console.error(`Reminder error for IOU ${iou.id}:`, err.message);
      }
    }

    if (remindersSent > 0) {
      console.log(`[ReminderService] Sent expense reminders for ${remindersSent} IOUs.`);
    }
  } catch (err) {
    console.error('[ReminderService] Error running expense reminders:', err.message);
  }
}

module.exports = { checkAndSendExpenseReminders };
