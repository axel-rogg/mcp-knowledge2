import { describe, it, expect, beforeAll } from 'vitest';
import { registerAllTools } from '../../src/mcp/register_tools.ts';
import { getRegisteredTools, resetToolsForTest } from '../../src/mcp/tools.ts';

beforeAll(() => {
  resetToolsForTest();
  registerAllTools();
});

describe('Phase-1 Wrapper-Migration sanity', () => {
  it('registers ≥63 tools (47 high-level + 16 low-level)', () => {
    const tools = getRegisteredTools();
    expect(tools.length).toBeGreaterThanOrEqual(63);
  });

  it('all KC2 primitives are tagged low-level', () => {
    const primitives = [
      'objects.create','objects.get','objects.list','objects.update',
      'objects.delete','objects.restore','objects.usages',
      'objects.add_ref','objects.remove_ref',
      'shares.create','shares.list','shares.revoke','shares.shared_with_me',
      'uploads.init','uploads.complete','uploads.status',
    ];
    const tools = getRegisteredTools();
    for (const name of primitives) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} registered`).toBeDefined();
      const tags = (t!.annotations as { tags?: string[] }).tags ?? [];
      expect(tags, `${name} tags`).toContain('low-level');
    }
  });

  it('all high-level wrappers are NOT tagged low-level', () => {
    const highLevel = [
      'notes.create','notes.update','notes.list','notes.get','notes.delete',
      'lists.create','lists.add_item','lists.tick','lists.untick','lists.list','lists.get',
      'memorize.add','memorize.search','memorize.list_recent','memorize.delete',
      'docs.put','docs.get','docs.list','docs.delete','docs.usages','docs.attach_to','docs.update_summary',
      'skills.put','skills.get','skills.get_bundle','skills.list','skills.delete','skills.search','skills.read_resource','skills.attach_resource','skills.detach_resource',
      'groups.create','groups.list','groups.get','groups.list_members','groups.add_member','groups.remove_member','groups.invite_email','groups.archive','groups.set_read_audit','groups.transfer_ownership',
      'docs.share_with_group','skills.share_with_group','shares.list_my_shares','shares.list_for_group',
      'objects.browse_list','objects.browse_read',
    ];
    const tools = getRegisteredTools();
    for (const name of highLevel) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} registered`).toBeDefined();
      const tags = (t!.annotations as { tags?: string[] }).tags ?? [];
      expect(tags, `${name} tags`).not.toContain('low-level');
    }
  });

  it('count breakdown matches plan §3.1', () => {
    const tools = getRegisteredTools();
    const byFamily = {
      notes: tools.filter((t) => t.name.startsWith('notes.')).length,
      lists: tools.filter((t) => t.name.startsWith('lists.')).length,
      memorize: tools.filter((t) => t.name.startsWith('memorize.')).length,
      docs: tools.filter((t) => t.name.startsWith('docs.')).length,
      skills: tools.filter((t) => t.name.startsWith('skills.')).length,
      groups: tools.filter((t) => t.name.startsWith('groups.')).length,
      shares: tools.filter((t) => t.name.startsWith('shares.')).length,
      objects: tools.filter((t) => t.name.startsWith('objects.')).length,
      uploads: tools.filter((t) => t.name.startsWith('uploads.')).length,
      admin: tools.filter((t) => t.name.startsWith('admin.')).length,
      users: tools.filter((t) => t.name.startsWith('users.')).length,
    };
    expect(byFamily, JSON.stringify(byFamily, null, 2)).toMatchObject({
      notes: 5,
      lists: 6,
      memorize: 4,
      docs: 8, // 7 high-level + 1 sharing helper (docs.share_with_group)
      skills: 10, // 9 high-level + 1 sharing helper (skills.share_with_group)
      groups: 10,
      shares: 6, // 4 primitives (create/list/revoke/shared_with_me) + 2 helpers (list_my_shares/list_for_group)
      // 9 primitives + browse_list/read + 3 ownership (move_to_group/_personal/transfer_ownership, Phase 3b.4)
      objects: 14,
      uploads: 3,
      // Phase 3b.4: admin.list_orphan_objects + admin.purge_orphan_object
      admin: 2,
      // Phase 3b.4: users.resolve_email
      users: 1,
    });
  });
});
