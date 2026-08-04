-- Sample data for local development / demos
-- Run after schema is applied. Safe to re-run only on an empty DB (uses fixed IDs).

BEGIN;

-- Seed is always for sample user "1" (Alon). Defaults make legacy INSERT shapes work.
ALTER TABLE patients ALTER COLUMN user_id SET DEFAULT '1';
ALTER TABLE patient_channel_identities ALTER COLUMN user_id SET DEFAULT '1';
ALTER TABLE appointments ALTER COLUMN user_id SET DEFAULT '1';
ALTER TABLE messages ALTER COLUMN user_id SET DEFAULT '1';
ALTER TABLE reminder_attempts ALTER COLUMN user_id SET DEFAULT '1';
ALTER TABLE activity_log ALTER COLUMN user_id SET DEFAULT '1';

-- Reset sequences-friendly inserts with explicit IDs
TRUNCATE
  activity_log,
  reminder_attempts,
  messages,
  appointments,
  patient_channel_identities,
  patients
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- 5 patients
-- ---------------------------------------------------------------------------
INSERT INTO patients (id, name, notes, user_id) VALUES
  (1, 'مریم احمدی', 'پیگیری تغذیه — پاسخ‌گو معمولاً از بله', '1'),
  (2, 'علی رضایی', NULL, '1'),
  (3, 'زهرا محمدی', 'گاهی پاسخ نامفهوم می‌فرستد', '1'),
  (4, 'حسین کریمی', 'ترجیح SMS', '1'),
  (5, 'فاطمه نوری', NULL, '1');

-- Both SMS + Bale for each patient (ids: sms 100000+, bale 200000+)
INSERT INTO patient_channel_identities (id, patient_id, channel, external_id, is_preferred, user_id) VALUES
  (200001, 1, 'bale', '200001', TRUE, '1'),
  (100001, 1, 'sms',  '09121234501', FALSE, '1'),
  (200002, 2, 'bale', '200002', TRUE, '1'),
  (100002, 2, 'sms',  '09121234502', FALSE, '1'),
  (200003, 3, 'bale', '200003', TRUE, '1'),
  (100003, 3, 'sms',  '09121234503', FALSE, '1'),
  (100004, 4, 'sms',  '09121234504', TRUE, '1'),
  (200004, 4, 'bale', '200004', FALSE, '1'),
  (200005, 5, 'bale', '200005', TRUE, '1'),
  (100005, 5, 'sms',  '09121234505', FALSE, '1');

-- Reminder template body (matches current clinic SMS copy)
-- "سلام وقت شما بخیر
-- وقت مراجعه پیگیری تغذیه شما :
-- یکشنبه ۱۱ مرداد ساعت۶:۱۵
-- لطفا حتما
-- *درصورت تایید بفرمایید « تایید شود»
-- *درصورت درخواست جابجایی بفرمایید « جابجا شود»
-- درصورت درخواست کنسلی بفرمایید « کنسل شود»"

-- ---------------------------------------------------------------------------
-- 10 appointments across statuses
-- ---------------------------------------------------------------------------
INSERT INTO appointments (id, patient_id, appointment_date, appointment_time, visit_type, status, user_id) VALUES
  (1,  1, '2026-08-02', '18:15', 'پیگیری تغذیه', 'confirmed', '1'),
  (2,  2, '2026-08-03', '10:00', 'پیگیری تغذیه', 'rescheduled', '1'),
  (3,  3, '2026-08-03', '11:30', 'پیگیری تغذیه', 'cancelled', '1'),
  (4,  4, '2026-08-04', '09:00', 'پیگیری تغذیه', 'needs_review', '1'),
  (5,  5, '2026-08-04', '16:45', 'پیگیری تغذیه', 'needs_review', '1'),
  (6,  1, '2026-08-05', '18:15', 'پیگیری تغذیه', 'scheduled', '1'),
  (7,  2, '2026-08-05', '10:30', 'پیگیری تغذیه', 'scheduled', '1'),
  (8,  3, '2026-08-06', '12:00', 'پیگیری تغذیه', 'no_response', '1'),
  (9,  4, '2026-08-06', '15:00', 'پیگیری تغذیه', 'scheduled', '1'),
  (10, 5, '2026-08-07', '17:30', 'پیگیری تغذیه', 'scheduled', '1');

-- ---------------------------------------------------------------------------
-- Messages — confirm / reschedule / cancel / needs_review / pending flows
-- ---------------------------------------------------------------------------

-- Appt 1: Bale reminder → patient confirms
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (1, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nیکشنبه ۱۱ مرداد ساعت۶:۱۵\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1001', 'delivered', NULL,
   NOW() - INTERVAL '26 hours', NOW() - INTERVAL '25 hours 58 minutes', NOW() - INTERVAL '26 hours'),
  (1, 'bale', 'inbound',
   'تایید شود',
   NULL, 'delivered', NULL,
   NULL, NULL, NOW() - INTERVAL '25 hours');

-- Appt 2: Bale reminder → reschedule
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (2, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nدوشنبه ۱۲ مرداد ساعت۱۰:۰۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1002', 'delivered', NULL,
   NOW() - INTERVAL '20 hours', NOW() - INTERVAL '19 hours 55 minutes', NOW() - INTERVAL '20 hours'),
  (2, 'bale', 'inbound',
   'جابجا شود',
   NULL, 'delivered', NULL,
   NULL, NULL, NOW() - INTERVAL '19 hours');

-- Appt 3: Bale reminder → cancel
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (3, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nدوشنبه ۱۲ مرداد ساعت۱۱:۳۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1003', 'delivered', NULL,
   NOW() - INTERVAL '18 hours', NOW() - INTERVAL '17 hours 50 minutes', NOW() - INTERVAL '18 hours'),
  (3, 'bale', 'inbound',
   'کنسل شود',
   NULL, 'delivered', NULL,
   NULL, NULL, NOW() - INTERVAL '17 hours');

-- Appt 4: needs_review — unparseable reply
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (4, 'sms', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nسه‌شنبه ۱۳ مرداد ساعت۹:۰۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'sms-out-2004', 'delivered', NULL,
   NOW() - INTERVAL '10 hours', NOW() - INTERVAL '9 hours 58 minutes', NOW() - INTERVAL '10 hours'),
  (4, 'sms', 'inbound',
   'فردا میام؟ ساعت رو بگید دوباره',
   NULL, 'delivered', NULL,
   NULL, NULL, NOW() - INTERVAL '9 hours');

-- Appt 5: needs_review — another unparseable reply
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (5, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nسه‌شنبه ۱۳ مرداد ساعت۱۶:۴۵\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1005', 'delivered', NULL,
   NOW() - INTERVAL '8 hours', NOW() - INTERVAL '7 hours 59 minutes', NOW() - INTERVAL '8 hours'),
  (5, 'bale', 'inbound',
   '👍',
   NULL, 'delivered', NULL,
   NULL, NULL, NOW() - INTERVAL '7 hours');

-- Appt 6: scheduled — recent outbound, waiting for reply
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (6, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nچهارشنبه ۱۴ مرداد ساعت۱۸:۱۵\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1006', 'delivered', NULL,
   NOW() - INTERVAL '1 hour', NOW() - INTERVAL '59 minutes', NOW() - INTERVAL '1 hour');

-- Appt 7: scheduled — Bale unanswered long enough → SMS fallback
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (7, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nچهارشنبه ۱۴ مرداد ساعت۱۰:۳۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1007', 'delivered', NULL,
   NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours 58 minutes', NOW() - INTERVAL '6 hours'),
  (7, 'sms', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nچهارشنبه ۱۴ مرداد ساعت۱۰:۳۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'sms-out-2007', 'sent', 'fallback_from_bale',
   NOW() - INTERVAL '2 hours', NULL, NOW() - INTERVAL '2 hours');

-- Appt 8: no_response after Bale + SMS
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (8, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nپنجشنبه ۱۵ مرداد ساعت۱۲:۰۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1008', 'delivered', NULL,
   NOW() - INTERVAL '30 hours', NOW() - INTERVAL '29 hours 55 minutes', NOW() - INTERVAL '30 hours'),
  (8, 'sms', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nپنجشنبه ۱۵ مرداد ساعت۱۲:۰۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'sms-out-2008', 'delivered', 'fallback_from_bale',
   NOW() - INTERVAL '24 hours', NOW() - INTERVAL '23 hours 50 minutes', NOW() - INTERVAL '24 hours');

-- Appt 9: scheduled — old outbound, candidate for no-response alert / fallback
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (9, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nپنجشنبه ۱۵ مرداد ساعت۱۵:۰۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   'bale-out-1009', 'delivered', NULL,
   NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours 58 minutes', NOW() - INTERVAL '5 hours');

-- Appt 10: scheduled — pending send
INSERT INTO messages (appointment_id, channel, direction, content, provider_message_id, delivery_status, note, sent_at, delivered_at, created_at) VALUES
  (10, 'bale', 'outbound',
   E'سلام وقت شما بخیر\nوقت مراجعه پیگیری تغذیه شما :\nجمعه ۱۶ مرداد ساعت۱۷:۳۰\n\nلطفا حتما\n*درصورت تایید بفرمایید\n « تایید شود»\n*درصورت درخواست جابجایی بفرمایید « جابجا شود»\nدرصورت درخواست کنسلی بفرمایید « کنسل شود»',
   NULL, 'pending', NULL,
   NULL, NULL, NOW() - INTERVAL '10 minutes');

-- ---------------------------------------------------------------------------
-- Reminder attempts
-- ---------------------------------------------------------------------------
INSERT INTO reminder_attempts (appointment_id, attempt_number, channel, attempted_at) VALUES
  (1, 1, 'bale', NOW() - INTERVAL '26 hours'),
  (2, 1, 'bale', NOW() - INTERVAL '20 hours'),
  (3, 1, 'bale', NOW() - INTERVAL '18 hours'),
  (4, 1, 'sms',  NOW() - INTERVAL '10 hours'),
  (5, 1, 'bale', NOW() - INTERVAL '8 hours'),
  (6, 1, 'bale', NOW() - INTERVAL '1 hour'),
  (7, 1, 'bale', NOW() - INTERVAL '6 hours'),
  (7, 2, 'sms',  NOW() - INTERVAL '2 hours'),
  (8, 1, 'bale', NOW() - INTERVAL '30 hours'),
  (8, 2, 'sms',  NOW() - INTERVAL '24 hours'),
  (9, 1, 'bale', NOW() - INTERVAL '5 hours'),
  (10, 1, 'bale', NOW() - INTERVAL '10 minutes');

-- ---------------------------------------------------------------------------
-- Activity log samples
-- ---------------------------------------------------------------------------
INSERT INTO activity_log (appointment_id, event_type, details, created_at) VALUES
  (1, 'webhook_received', '{"provider":"bale","event":"delivered","provider_message_id":"bale-out-1001"}'::jsonb, NOW() - INTERVAL '25 hours 58 minutes'),
  (2, 'webhook_received', '{"provider":"bale","event":"inbound","parsed_intent":"reschedule"}'::jsonb, NOW() - INTERVAL '19 hours'),
  (4, 'manual_override', '{"reason":"unparseable_response","action":"flagged_needs_review"}'::jsonb, NOW() - INTERVAL '8 hours 30 minutes'),
  (5, 'manual_override', '{"reason":"unparseable_response","raw":"👍"}'::jsonb, NOW() - INTERVAL '6 hours 45 minutes'),
  (7, 'fallback_triggered', '{"from":"bale","to":"sms","hours_waited":4}'::jsonb, NOW() - INTERVAL '2 hours'),
  (8, 'no_response_alert', '{"channels_tried":["bale","sms"],"hours_since_first":30}'::jsonb, NOW() - INTERVAL '12 hours'),
  (9, 'no_response_alert', '{"channel":"bale","hours_since_outbound":5}'::jsonb, NOW() - INTERVAL '5 minutes'),
  (NULL, 'webhook_received', '{"provider":"sms","event":"delivery_report","note":"orphan_webhook_no_appointment_match"}'::jsonb, NOW() - INTERVAL '3 hours');

SELECT setval('patients_id_seq', (SELECT MAX(id) FROM patients));
SELECT setval('patient_channel_identities_id_seq', (SELECT MAX(id) FROM patient_channel_identities));
SELECT setval('appointments_id_seq', (SELECT MAX(id) FROM appointments));
SELECT setval('messages_id_seq', (SELECT MAX(id) FROM messages));
SELECT setval('reminder_attempts_id_seq', (SELECT MAX(id) FROM reminder_attempts));
SELECT setval('activity_log_id_seq', (SELECT MAX(id) FROM activity_log));

ALTER TABLE patients ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE patient_channel_identities ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE appointments ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE messages ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE reminder_attempts ALTER COLUMN user_id DROP DEFAULT;
ALTER TABLE activity_log ALTER COLUMN user_id DROP DEFAULT;

COMMIT;
