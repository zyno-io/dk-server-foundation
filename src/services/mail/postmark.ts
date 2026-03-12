import { ScopedLogger } from '@deepkit/logger';
import { ServerClient } from 'postmark';

import type { MailProvider, PreparedMessageProperties } from '.';

import { BaseAppConfig } from '../../app';

export class PostmarkProvider implements MailProvider {
    private postmarkClient = new ServerClient(this.config.POSTMARK_SECRET!);

    constructor(
        private config: BaseAppConfig,
        private logger: ScopedLogger
    ) {
        if (!this.config.POSTMARK_SECRET) {
            throw new Error('POSTMARK_SECRET is not set');
        }
    }

    async send(message: PreparedMessageProperties): Promise<string> {
        const response = await this.postmarkClient.sendEmail({
            From: message.from,
            To: message.to,
            Subject: message.subject,
            HtmlBody: message.message,
            TextBody: message.plainMessage,
            ReplyTo: message.replyTo,
            Attachments: message.attachments?.map(attachment => ({
                Name: attachment.name,
                Content: attachment.content.toString('base64'),
                ContentType: attachment.contentType,
                ContentID: attachment.cid ?? null,
                ContentLength: attachment.content.length
            }))
        });
        return response.MessageID;
    }
}
