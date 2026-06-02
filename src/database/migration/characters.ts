import { cli } from '@deepkit/app';
import { SQLDatabaseAdapter } from '@deepkit/sql';

import { DBProvider } from '../../app/state';
import { BaseDatabase } from '../common';
import { getDialect } from '../dialect';

interface ICollationOptions {
    charset?: string;
    collation?: string;
}

const DEFAULT_CHARSET = 'utf8mb4';
const DEFAULT_COLLATION = 'utf8mb4_0900_ai_ci';

export async function standardizeDbCollation(db: BaseDatabase, options?: ICollationOptions) {
    const dialect = getDialect(db.adapter as SQLDatabaseAdapter);
    if (dialect === 'postgres') {
        console.warn('standardizeDbCollation is not applicable to PostgreSQL — skipping');
        return;
    }

    const charset = options?.charset ?? DEFAULT_CHARSET;
    const collation = options?.collation ?? DEFAULT_COLLATION;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbNameResult: any[] = await db.rawQuery('SELECT DATABASE()');
    const dbName = Object.values(dbNameResult[0])[0];

    await db.rawQuery(`ALTER DATABASE ${dbName} CHARACTER SET = ${charset} COLLATE = ${collation}`);

    const tablesResult = await db.rawQuery('SHOW TABLES');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tables = tablesResult.map((row: any) => Object.values(row)[0]);

    for (const table of tables) {
        await db.rawQuery(`ALTER TABLE ${table} CONVERT TO CHARACTER SET ${charset} COLLATE ${collation}`);
    }
}

@cli.controller('migrate:charset')
export class MigrationCharactersCommand {
    constructor(private dbProvider: DBProvider) {}

    async execute(charset: string = DEFAULT_CHARSET, collation: string = DEFAULT_COLLATION) {
        const dialect = getDialect(this.dbProvider.db.adapter as SQLDatabaseAdapter);
        if (dialect === 'postgres') {
            console.warn('Character set standardization is not applicable to PostgreSQL');
            return;
        }
        await standardizeDbCollation(this.dbProvider.db, { charset, collation });
    }
}
