import { describe, expect, test } from 'bun:test';
import {
  enrollableSignets,
  formatMap,
  kingdomMap,
  overviewSchema,
  reachableFromMap,
  readOverview,
} from '../src/overview';
import { id, orgOwner, overview, tribe, viewer } from './fixtures';

describe('overview', () => {
  test('reads the overview with the API token as a bearer', async () => {
    const seen = { authorization: null as string | null, path: '' };
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.path = String(input);
      seen.authorization = new Headers(init?.headers).get('authorization');
      return Response.json({ data: overview() });
    }) as typeof fetch;
    const read = await readOverview('http://localhost:4100', 'test_user_token', transport);
    expect(seen.path).toBe('http://localhost:4100/api/v1/me/overview');
    expect(seen.authorization).toBe('Bearer test_user_token');
    expect(read.dashboard.viewerUserId).toBe(viewer);
  });
  test('a refusal says so without echoing the token', async () => {
    const transport = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(
      readOverview('http://localhost:4100', 'test_user_token', transport),
    ).rejects.toThrow(/\(401\)/);
  });
  test('enrollable: issued to the viewer, not revoked, closed or expired', () => {
    expect(enrollableSignets(overviewSchema.parse(overview())).map((signet) => signet.id)).toEqual([
      id(11),
    ]);
  });
  test('maps owners to their live integrations, marking held Signets', () => {
    const owners = kingdomMap(overviewSchema.parse(overview()), new Set([id(11)]));
    expect(owners.map((owner) => owner.name)).toEqual(['Personal', 'Tribe']);
    const tribeGroup = owners[1];
    expect(tribeGroup?.owner).toEqual(orgOwner(tribe));
    expect(tribeGroup?.integrations).toEqual([
      {
        id: id(1),
        name: 'Tribe Railway',
        provider: 'railway',
        enabled: true,
        manages: true,
        held: [id(11)],
        resources: [{ id: id(21), name: 'api', kind: 'service' }],
      },
    ]);
    expect(reachableFromMap(owners)).toEqual([
      {
        integrationId: id(1),
        provider: 'railway',
        owner: orgOwner(tribe),
        name: 'Tribe Railway',
        signetId: id(11),
      },
    ]);
    const text = formatMap(owners);
    expect(text).toContain('Personal');
    expect(text).toContain('(no integrations)');
    expect(text).toContain(`railway  Tribe Railway  -i ${id(1)}  [manage; held ${id(11)}]`);
  });
});
