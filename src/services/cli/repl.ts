import { cli } from '@deepkit/app';
import * as repl from 'repl';

import { buildReplContext } from './repl-context';

@cli.controller('repl', {
    description: 'Start a REPL'
})
export class ReplCommand {
    constructor() {}

    async execute() {
        buildReplContext();

        return new Promise<void>(resolve => {
            const replServer = repl.start();
            replServer.on('exit', () => {
                resolve();
            });
        });
    }
}
