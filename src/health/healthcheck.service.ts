type HealthcheckFn = () => Promise<void>;

export class HealthcheckService {
    private checks: { name: string; fn: HealthcheckFn }[] = [];

    public register(fn: HealthcheckFn, name?: string) {
        this.checks.push({ name: name ?? `Check #${this.checks.length + 1}`, fn });
    }

    public async check() {
        for (const check of this.checks) {
            await check.fn();
        }
    }

    public async checkIndividual(): Promise<{ name: string; status: 'ok' | 'error'; error?: string }[]> {
        const results: { name: string; status: 'ok' | 'error'; error?: string }[] = [];
        for (const check of this.checks) {
            try {
                await check.fn();
                results.push({ name: check.name, status: 'ok' });
            } catch (err) {
                results.push({ name: check.name, status: 'error', error: err instanceof Error ? err.message : String(err) });
            }
        }
        return results;
    }
}
