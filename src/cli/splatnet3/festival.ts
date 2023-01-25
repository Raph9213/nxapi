import createDebug from 'debug';
import { FestState } from 'splatnet3-types/splatnet3';
import Table from '../util/table.js';
import type { Arguments as ParentArguments } from '../splatnet3.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../../util/yargs.js';
import { initStorage } from '../../util/storage.js';
import { getBulletToken } from '../../common/auth/splatnet3.js';

const debug = createDebug('cli:splatnet3:festival');

export const command = 'festival <id>';
export const desc = 'Show details about a specific Splatfest in your region';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.positional('id', {
        describe: 'Splatfest ID',
        type: 'string',
        demandOption: true,
    }).option('user', {
        describe: 'Nintendo Account ID',
        type: 'string',
    }).option('token', {
        describe: 'Nintendo Account session token',
        type: 'string',
    }).option('json', {
        describe: 'Output raw JSON',
        type: 'boolean',
    }).option('json-pretty-print', {
        describe: 'Output pretty-printed JSON',
        type: 'boolean',
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const storage = await initStorage(argv.dataPath);

    const usernsid = argv.user ?? await storage.getItem('SelectedUser');
    const token: string = argv.token ||
        await storage.getItem('NintendoAccountToken.' + usernsid);
    const {splatnet, data} = await getBulletToken(storage, token, argv.zncProxyUrl, argv.autoUpdateSession);

    const fest_records = await splatnet.getFestRecords();

    const req_id = argv.id;
    const encoded_req_id = Buffer.from(req_id).toString('base64');
    const encoded_part_req_id = Buffer.from('Fest-' + req_id).toString('base64');
    const fest_record = fest_records.data.festRecords.nodes.find(f => f.id === req_id ||
        f.id === encoded_req_id || f.id === encoded_part_req_id);

    if (!fest_record) {
        throw new Error('Invalid Splatfest ID');
    }

    const fest = (await splatnet.getFestDetail(fest_record.id)).data.fest;
    const fest_votes = fest.state !== FestState.CLOSED ?
        (await splatnet.getFestVotingStatus(fest_record.id)).data.fest : null;

    if (argv.jsonPrettyPrint) {
        console.log(JSON.stringify({fest: fest, votes: fest_votes ?? undefined}, null, 4));
        return;
    }
    if (argv.json) {
        console.log(JSON.stringify({fest: fest, votes: fest_votes ?? undefined}));
        return;
    }

    console.log('Details', fest);

    if (fest_votes) {
        const table = new Table({
            head: [
                'Name',
                'State',
                'Team',
            ],
        });

        for (const team of fest_votes.teams) {
            for (const vote of team.votes?.nodes ?? []) {
                table.push([vote.playerName, 'Voted', team.teamName]);
            }
            for (const vote of team.preVotes?.nodes ?? []) {
                table.push([vote.playerName, 'Planning to vote', team.teamName]);
            }
        }

        for (const vote of fest_votes.undecidedVotes?.nodes ?? []) {
            table.push([vote.playerName, 'Undecided', '-']);
        }

        console.log('Friends votes');
        console.log(table.toString());
    }
}
