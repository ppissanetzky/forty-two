
import assert from 'node:assert';

import { Database } from './db';
import { makeDebug } from './utility';
import Dispatcher from './dispatcher';
import TexasTime from './texas-time';
import Tournament, { TournamentRow } from './tournament';
import config from './config';

const debug = makeDebug('scheduler');

const database = new Database('tournaments', 0);


function insertTestTourneys() {
    if (config.PRODUCTION) {
        return;
    }
    database.run('delete from tournaments');
    const now = TexasTime.today();
    const d = now.date;
    d.setMinutes(d.getMinutes() + 1);
    const signup = new TexasTime(d).toString();
    d.setMinutes(d.getMinutes() + 5);
    const e = new TexasTime(d).toString();
    d.setMinutes(d.getMinutes() + 1);
    const s = new TexasTime(d).toString();

    const t = new Tournament({
        id: 0,
        name: `Today's test tournament`,
        type: 1,
        signup_start_dt: signup,
        signup_end_dt: e,
        start_dt: s,
        rules: '',
        partner: 1,
        seed: 0,
        timezone: 'CST',
        signup_opened: 0,
        signup_closed: 0,
        started: 0,
        scheduled: 0,
        finished: 0,
        ladder_id: 0,
        ladder_name: '',
        lmdtm: '',
        invitation: 0,
        recurring: 0,
        invitees: '',
        prize: '',
        winners: '',
        recurring_source: 0,
        host: ''
    });
    t.saveWith({});
}


interface SchedulerEvents {
    signupOpen: Tournament;
    signupClosed: Tournament;
    started: Tournament;
    canceled: Tournament;
    finished: Tournament;
    registered: {
        t: Tournament;
        user: string;
        partner?: string;
    },
    unregistered: {
        t: Tournament;
        user: string;
    }
}

export default class Scheduler extends Dispatcher<SchedulerEvents> {

    public static get(): Scheduler {
        if (!this.instance) {
            this.instance = new Scheduler();
        }
        return this.instance;
    }

    private static instance?: Scheduler;

    public tourneys = new Map<number, Tournament>();

    private constructor() {
        super();
        this.loadToday();
    }

    private loadToday(): void {
        insertTestTourneys();

        const today = TexasTime.today();

        for (const t of this.todaysTournaments(today)) {
            this.tourneys.set(t.id, new Tournament(t));
            debug('loaded', t.id, t.start_dt, t.name);
        }

        for (const t of this.todaysRecurringTournaments(today)) {
            const instance = this.createRecurringInstance(today, t);
            if (instance) {
                this.tourneys.set(instance.id, instance);
            }
        }

        debug('have', this.tourneys.size, 'to schedule');

        const now = TexasTime.today();
        for (const t of this.tourneys.values()) {
            const ms = Math.max(100, now.msUntil(TexasTime.parse(t.signup_start_dt)));
            debug('signup in', ms, 'for', t.id, t.signup_start_dt, t.name);
            setTimeout(() => this.openSignup(t), ms);
        }

        const tomorrow = TexasTime.midnight();
        const ms = now.msUntil(tomorrow) + 1000;
        debug('tomorrow', tomorrow.toString(), 'in', ms);
        setTimeout(() => this.loadToday(), ms);
    }

    /**
     * Loads all recurring tournaments that don't already have an instance
     * for today
     */

    private todaysRecurringTournaments(today: TexasTime): TournamentRow[] {
        const date = today.dateString;
        const dow = today.dayOfWeek;
        return database.all(
            `
            SELECT * FROM tournaments
            WHERE
                (recurring = $dow OR recurring = 8 OR
                (recurring = 9 AND $dow in (1, 2, 3, 4, 5)))
                AND id NOT IN (
                    SELECT recurring_source FROM tournaments AS other
                    WHERE date(other.start_dt) = date($date)
                )
            ORDER BY
                time(start_dt)
            `
            , { date, dow }
        );
    }

    private todaysTournaments(today: TexasTime): TournamentRow[] {
        const date = today.toString();
        return database.all(
            `
            SELECT * FROM tournaments
            WHERE
                date(start_dt) = date($date)
                AND time(start_dt) > time($date)
                AND started = 0
                AND finished = 0
                AND scheduled = 0
                AND recurring = 0
            ORDER BY
                start_dt
            `
            , { date }
        );
    }

    private createRecurringInstance(today: TexasTime, t: TournamentRow): Tournament | undefined {
        assert(t.recurring);

        /** The new start date time for this instance */
        const start = today.withTimeFrom(TexasTime.parse(t.start_dt));

        /** See if the start time is earlier than now */
        if (today.minutesUntil(start) < 5) {
            debug('expired', t.id, start.toString(), t.name);
            return;
        }

        /** Create and save the new instance */
        const instance = new Tournament(t).saveWith({
            id: 0,
            start_dt: start.toString(),
            signup_start_dt: today.withTimeFrom(TexasTime.parse(t.signup_start_dt)).toString(),
            signup_end_dt: today.withTimeFrom(TexasTime.parse(t.signup_end_dt)).toString(),
            signup_opened: 0,
            signup_closed: 0,
            started: 0,
            scheduled: 0,
            finished: 0,
            invitees: '',
            winners: '',
            recurring: 0,
            recurring_source: t.id
        });

        debug('created', instance.id, instance.start_dt, instance.name);

        return instance;
    }

    private openSignup(t: Tournament) {
        if (!t.signup_opened) {
            t.saveWith({
                signup_opened: 1
            });
            debug('signup opened for', t.id, t.signup_start_dt, t.name);
            this.emit('signupOpen', t);
        }

        const now = TexasTime.today();
        const ms = Math.max(100, now.msUntil(TexasTime.parse(t.signup_end_dt)));
        setTimeout(() => this.closeSignup(t), ms);
        debug('signup close in', ms, t.id, t.signup_end_dt, t.name);
    }

    private closeSignup(t: Tournament) {
        if (!t.signup_closed) {
            t.saveWith({
                signup_closed: 1
            });
            debug('signup closed for', t.id, t.signup_end_dt, t.name);
            this.emit('signupClosed', t);
        }

        // TODO: check signups, if not enough, will go to canceled

        const now = TexasTime.today();
        const ms = Math.max(100, now.msUntil(TexasTime.parse(t.start_dt)));
        debug('start in', ms, t.id, t.signup_end_dt, t.name);
        setTimeout(() => this.start(t), ms);
    }

    private start(t: Tournament) {
        t.saveWith({
            started: 1
        });
        debug('started', t.id, t.start_dt, t.name);
        this.emit('started', t);
    }

    public register(id: number, user: string, partner = ''): [Tournament, boolean] {
        assert(user);
        const t = this.tourneys.get(id);
        assert(t, `Invalid tournament ${id}`);
        assert(t.signup_opened && !t.signup_closed, `Signup is not open for ${id}`);
        assert(user !== partner, 'Yourself as partner?');
        if (t.invitation && !t.invitees.includes(user)) {
            assert(false, 'Not invited');
        }
        for (const other of this.tourneys.values()) {
            if (other === t) {
                continue;
            }
            if (other.signup_opened && !other.started && !other.finished) {
                if (other.signups().has(user)) {
                    assert(false, `Already registered for ${other.id}`);
                }
            }
            // TODO: check if this user is still playing in other
        }
        /** Check to see if it already exists */

        const existing = database.first(
            `
            SELECT user FROM signups
            WHERE id = $id and user = $user and partner IS $partner`
            , { id, user, partner: partner || null }
        );
        if (existing) {
            return [t, false];
        }

        // In the DB
        database.run(
            `
            INSERT OR REPLACE INTO signups
            (id, user, partner) VALUES ($id, $user, $partner)
            `
            , { id, user, partner: partner || null }
        );
        this.emit('registered', {
            t,
            user,
            partner
        });
        return [t, true];
    }

    public unregister(id: number, user: string): [Tournament, boolean] {
        assert(user);
        const t = this.tourneys.get(id);
        assert(t, `Invalid tournament ${id}`);
        assert(t.signup_opened && !t.signup_closed, `Signup not open for ${id}`);
        assert(t.signups().has(user), `Not signed up for ${id}`);
        const changed = database.change(
            `
            DELETE from signups WHERE id = $id AND user = $user
            `
            , { id, user }
        );
        if (changed === 0) {
            return [t, false];
        }
        this.emit('unregistered', {
            t,
            user
        });
        return [t, true];
    }
}
