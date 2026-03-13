import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';

import { MeshClientRedisRegistry, MeshClientRegistry, destroyClientRedis, TestingHelpers, disconnectAllRedis } from '../../../src';

interface TestMeta {
    userId: string;
    role: string;
}

describe('MeshClientRegistry', () => {
    const tf = TestingHelpers.createTestingFacade({
        defaultConfig: {
            REDIS_HOST: 'localhost',
            REDIS_PORT: 6379
        }
    });
    before(() => tf.start());
    after(async () => {
        await tf.stop();
        destroyClientRedis();
        await disconnectAllRedis();
    });

    let keyCounter = 0;
    let backend: MeshClientRedisRegistry<TestMeta>;
    let registry1: MeshClientRegistry<TestMeta>;
    let registry2: MeshClientRegistry<TestMeta>;

    beforeEach(() => {
        const key = `test-cr-${++keyCounter}`;
        backend = new MeshClientRedisRegistry<TestMeta>(key);
        registry1 = new MeshClientRegistry<TestMeta>(1, backend);
        registry2 = new MeshClientRegistry<TestMeta>(2, backend);
    });

    it('registers and retrieves a client', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });

        const client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.clientId, 'client-1');
        assert.strictEqual(client.nodeId, 1);
        assert.deepStrictEqual(client.metadata, { userId: 'u1', role: 'admin' });
    });

    it('lists all clients across nodes', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        await registry2.register('client-2', { userId: 'u2', role: 'user' });

        const all = await registry1.listClients();
        assert.strictEqual(all.length, 2);

        const ids = all.map(c => c.clientId).sort();
        assert.deepStrictEqual(ids, ['client-1', 'client-2']);
    });

    it('lists clients for a specific node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        await registry1.register('client-2', { userId: 'u2', role: 'user' });
        await registry2.register('client-3', { userId: 'u3', role: 'user' });

        const node1Clients = await registry1.listClientsForNode(1);
        assert.strictEqual(node1Clients.length, 2);

        const node2Clients = await registry1.listClientsForNode(2);
        assert.strictEqual(node2Clients.length, 1);
        assert.strictEqual(node2Clients[0].clientId, 'client-3');
    });

    it('listClientsForNode defaults to own node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        await registry2.register('client-2', { userId: 'u2', role: 'user' });

        const myClients = await registry1.listClientsForNode();
        assert.strictEqual(myClients.length, 1);
        assert.strictEqual(myClients[0].clientId, 'client-1');
    });

    it('unregister returns true when owned by this node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        const removed = await registry1.unregister('client-1');
        assert.strictEqual(removed, true);

        const client = await registry1.getClient('client-1');
        assert.strictEqual(client, undefined);
    });

    it('unregister returns false when client does not exist', async () => {
        const removed = await registry1.unregister('nonexistent');
        assert.strictEqual(removed, false);
    });

    it('unregister returns false when client moved to another node (ownership check)', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });

        // Client reconnects to node 2
        await registry2.register('client-1', { userId: 'u1', role: 'admin' });

        // Node 1 tries to unregister — should fail because client moved
        const removed = await registry1.unregister('client-1');
        assert.strictEqual(removed, false);

        // Client should still be registered on node 2
        const client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.nodeId, 2);
    });

    it('cross-node reconnect atomically moves client', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });

        // Verify on node 1
        let client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.nodeId, 1);

        // Client reconnects to node 2
        await registry2.register('client-1', { userId: 'u1', role: 'admin' });

        // Should now be on node 2
        client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.nodeId, 2);

        // Node 1 should no longer list it
        const node1Clients = await registry1.listClientsForNode(1);
        assert.strictEqual(node1Clients.length, 0);
    });

    it('cleanupNode removes only clients still owned by that node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        await registry1.register('client-2', { userId: 'u2', role: 'user' });

        // Client-2 reconnects to node 2 before cleanup
        await registry2.register('client-2', { userId: 'u2', role: 'user' });

        // Cleanup node 1 — should only remove client-1
        const orphaned = await registry1.cleanupNode(1);
        assert.strictEqual(orphaned.length, 1);
        assert.strictEqual(orphaned[0].clientId, 'client-1');
        assert.deepStrictEqual(orphaned[0].metadata, { userId: 'u1', role: 'admin' });

        // client-2 should still be on node 2
        const client2 = await registry1.getClient('client-2');
        assert.ok(client2);
        assert.strictEqual(client2.nodeId, 2);
    });

    it('cleanupNode returns full RegisteredClient list', async () => {
        await registry1.register('client-a', { userId: 'ua', role: 'admin' });
        await registry1.register('client-b', { userId: 'ub', role: 'user' });

        const orphaned = await registry1.cleanupNode(1);
        assert.strictEqual(orphaned.length, 2);

        for (const client of orphaned) {
            assert.ok(client.clientId);
            assert.ok(client.metadata);
            assert.ok(client.metadata.userId);
        }
    });

    it('cleanupNode defaults to own node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });

        const orphaned = await registry1.cleanupNode();
        assert.strictEqual(orphaned.length, 1);
        assert.strictEqual(orphaned[0].clientId, 'client-1');
    });

    it('getClient returns undefined for non-existent client', async () => {
        const client = await registry1.getClient('nonexistent');
        assert.strictEqual(client, undefined);
    });

    it('handles concurrent registrations', async () => {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            const reg = i % 2 === 0 ? registry1 : registry2;
            promises.push(reg.register(`client-${i}`, { userId: `u${i}`, role: 'user' }));
        }
        await Promise.all(promises);

        const all = await registry1.listClients();
        assert.strictEqual(all.length, 10);
    });

    it('cleanupNode with empty node set returns empty array', async () => {
        // Node 99 has no clients registered
        const orphaned = await backend.cleanupNode(99);
        assert.strictEqual(orphaned.length, 0);
    });

    it('listClientsForNode returns empty array for unknown node', async () => {
        const clients = await registry1.listClientsForNode(99);
        assert.strictEqual(clients.length, 0);
    });

    it('updateMetadata updates metadata for owned client', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'user' });

        const updated = await registry1.updateMetadata('client-1', { userId: 'u1', role: 'superadmin' });
        assert.strictEqual(updated, true);

        const client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.metadata.role, 'superadmin');
        assert.strictEqual(client.nodeId, 1); // nodeId unchanged
    });

    it('updateMetadata returns false when client moved to another node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'user' });
        await registry2.register('client-1', { userId: 'u1', role: 'user' });

        const updated = await registry1.updateMetadata('client-1', { userId: 'u1', role: 'superadmin' });
        assert.strictEqual(updated, false);

        // Metadata should be unchanged
        const client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.metadata.role, 'user');
        assert.strictEqual(client.nodeId, 2);
    });

    it('updateMetadata returns false for non-existent client', async () => {
        const updated = await registry1.updateMetadata('nonexistent', { userId: 'u1', role: 'admin' });
        assert.strictEqual(updated, false);
    });

    it('register returns null for new client', async () => {
        const result = await registry1.register('client-new', { userId: 'u1', role: 'user' });
        assert.strictEqual(result, null);
    });

    it('register returns null when re-registering on same node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'user' });
        const result = await registry1.register('client-1', { userId: 'u1', role: 'admin' });
        assert.strictEqual(result, null);
    });

    it('register returns superseded nodeId when client moves between nodes', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'user' });
        const result = await registry2.register('client-1', { userId: 'u1', role: 'user' });
        assert.strictEqual(result, 1);
    });

    it('register updates metadata for existing client on same node', async () => {
        await registry1.register('client-1', { userId: 'u1', role: 'user' });
        await registry1.register('client-1', { userId: 'u1', role: 'admin' });

        const client = await registry1.getClient('client-1');
        assert.ok(client);
        assert.strictEqual(client.metadata.role, 'admin');
    });
});
