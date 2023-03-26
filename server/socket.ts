import _ from 'lodash';
import { WebSocket } from 'ws';

import { makeDebug } from './utility';
import { OutgoingMessages } from './outgoing-messages';
import type { IncomingMessages } from './incoming-messages';
import Dispatcher from './dispatcher';
import UserHandler from './user-handler';
import { stringify, parse } from './json';
import GameRoom from './game-room';

interface Sent<T extends keyof OutgoingMessages, R extends keyof IncomingMessages> {
    readonly mid: number;
    readonly type: T;
    readonly message: OutgoingMessages[T];
    readonly reply?: R;
    readonly resolve: (value?: IncomingMessages[R]) => void;
}


/**
 * This is a connected WebSocket with a user name. It emits all the
 * incoming messages from this user and can send all the outgoing messages.
 */

export default class Socket extends Dispatcher<IncomingMessages> {

    static connected(name: string, ws: WebSocket): Socket {
        return new Socket(name, ws);
    }

    public readonly name: string;

    /**
     * A promise that is resolved when the ws is disconnected. It resolves
     * with the outstanding messages. An array of 'Sent'
     */

    public readonly gone: Promise<void>;

    /**
     * The next ack ID
     */

    private ACK = 2000;

    /**
     * An array of messages that either have not been sent, failed to send or
     * are waiting for a reply.
     */

    private readonly outstanding: any[] = [];

    private readonly debug = makeDebug('socket');
    private readonly ws: WebSocket;

    private readonly handler: UserHandler;

    private constructor(name: string, ws: WebSocket) {
        super();
        this.name = name;
        this.debug = this.debug.extend(name);
        this.ws = ws;
        this.debug('created');
        this.gone = new Promise((resolve) => {
            ws.once('close', (code, reason) => {
                this.debug('close', code, reason.toString(),
                    'outstanding', this.outstanding.length);
                resolve();
            });
        });
        this.handler = new UserHandler(this);

        ws.on('error', (error) => this.debug('error', error));

        ws.on('message', (data) => {
            try {
                const s = data.toString();
                this.debug('<-', s);
                const { ack, type, message }
                    : { ack?: number, type: keyof IncomingMessages, message: any }
                    = parse(s);
                if (ack) {
                    const outstanding = this.outstanding
                        .find(({mid}) => mid === ack);
                    if (outstanding) {
                        _.pull(this.outstanding, outstanding);
                        this.debug('ack', ack);
                        outstanding.resolve(message);
                    }
                    else {
                        this.debug('ack', ack, 'not outstanding');
                    }
                }
                if (type) {
                    this.emit(type, message);
                }
            }
            catch (error) {
                this.debug('message failed', error, data.toString());
            }
        });

        // Send the welcome message
        const rooms = GameRoom.roomsForUser(name);
        const hosting = rooms.find((room) => room.host === name)?.id;
        const invited = rooms.filter(({id}) => id !== hosting)
            .map(({id}) => id);
        this.send('welcome', {hosting, invited});
    }

    send<T extends keyof OutgoingMessages, R extends keyof IncomingMessages>(
        type: T,
        message: OutgoingMessages[T],
        reply?: R
    ): Promise<IncomingMessages[R] | void> {
        return new Promise((resolve) => {
            const mid = this.ACK++;
            const ack = reply ? mid : undefined;
            const outstanding: Sent<T, R> = {
                mid,
                type,
                message,
                reply,
                resolve,
                // reject
            };
            this.outstanding.push(outstanding);
            this.ws.send(stringify({
                ack: reply ? mid : undefined,
                type,
                message: message || undefined
            }), (error) => {
                if (error) {
                    this.debug('->', 'failed', error);
                    // Not rejecting the promise: we leave it alone
                    // for someone else to do it. It'll stay in the list
                    // of outstanding messages
                    return;
                }
                this.debug('->', ack || '', type, message);
                // If there is no reply, we're not waiting for a response
                // and we just sent it, so we take it out of the array
                // and resolve the promise since it was sent
                if (!reply) {
                    _.pull(this.outstanding, outstanding);
                    resolve();
                }
            });
        });
    }

    async replay(target: Socket): Promise<void> {
        const next = this.outstanding.shift();
        if (!next) {
            this.debug('replay done');
            return;
        }
        const { type, message, reply } = next;
        this.debug('replaying', type, message, reply);
        const response = await target.send(type, message, reply);
        next.resolve(response);
        return this.replay(target);
    }
}