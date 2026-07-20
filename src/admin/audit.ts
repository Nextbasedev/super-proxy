import { getDb } from '../db/index.js';

export function audit(input: { actorUserId?: number | null; action: string; targetType: string; targetId?: string | number; before?: unknown; after?: unknown }) {
  getDb().prepare('INSERT INTO admin_audit_logs (actor_user_id,action,target_type,target_id,before_json,after_json) VALUES (?,?,?,?,?,?)')
    .run(input.actorUserId || null, input.action, input.targetType, input.targetId == null ? null : String(input.targetId), input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null);
}
