/**
 * Store SMS.ir packId alongside provider_message_id for delivery polling.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumn('messages', {
    provider_pack_id: { type: 'varchar(255)' },
  });
  pgm.createIndex('messages', 'provider_pack_id', {
    name: 'idx_messages_provider_pack_id',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('messages', 'provider_pack_id', {
    name: 'idx_messages_provider_pack_id',
  });
  pgm.dropColumn('messages', 'provider_pack_id');
};
