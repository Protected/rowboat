import fs from 'fs';
import crypto from 'crypto';
import { promisify } from 'util';
import { Readable } from 'stream';
import ytdl from 'ytdl-core';
import FFmpeg from 'fluent-ffmpeg';
import moment from 'moment';
import random from 'meteor-random';

import { analyzeVolume } from './Grabber/loudness.js';

import Behavior from '../src/Behavior.js';

const INDEXFILE = 'index.json';
const STATSFILE = 'stats.json';

const GET_FIELDS = ['name', 'author', 'album', 'track', 'length', 'source', 'sourceSpecificId', 'loudness', 'sharedBy', 'hash'];
const SET_FIELDS = ['name', 'author', 'album', 'track'];
const NUMBER_FIELDS = ['track'];

const AUDIO_FORMATS = ['mp3', 'flac', 'pcm'];

/* Events:
    newSong (messageObj, messageAuthor, reply, hash)                    A new song was added to the index.
    songExistsOnScan (messageObj, messageAuthor, reply, hash)           An existing song was detected when scanning a channel.
    removeSong (hash, ismoderator, removerid)                           A song is about to be removed from the index.
*/

export default class Grabber extends Behavior {

    get description() { return "Downloads song files referenced in a Discord channel and maintains a dynamic index"; }

    get params() { return [
        {n: 'channels', d: "List of IDs of the Discord channels to be used"},
        {n: 'ffmpegPath', d: "Explicitly provide a path to the ffmpeg executable"},
        {n: 'ffprobePath', d: "Explicitly provide a path to the ffprobe executable"},
        {n: 'downloadPath', d: "Relative path to store the downloaded files (index.json will also be created here)"},
        {n: 'minDuration', d: "Minimum duration of the audio file (seconds)"},
        {n: 'maxDuration', d: "Maximum duration of the audio file (seconds)"},
        {n: 'maxDiskUsage', d: "Amount of disk space grabber is allowed to use in the downloadPath excluding index (bytes)"},
        {n: 'maxSimDownloads', d: "Maximum simultaneous actions (downloads or fixes)"},
        {n: 'scanDelay', d: "Delay between attempts to process messages (pending messages are queued) (ms)"},
        {n: 'selfDeleteExpiration', d: "Deadline for sharer to delete a song (counted from song's first share) (s)"},
        {n: 'permissionsDeleteAll', d: "List of sufficient permissions for deleting songs not shared by the user"},
        {n: 'permissionsReplace', d: "List of sufficient permissions for replacing previously indexed songs"},
        {n: 'allowedFormats', d: "List of allowed storage formats (subset of: " + AUDIO_FORMATS.join(", ") + ")"},
        {n: 'defaultFormat', d: "Default storage format. One of the allowed formats."},
        {n: 'defaultBehavior', d: "How to treat music messages by default. One of: 'ignore', 'quiet', 'feedback'"},
        {n: 'tagIgnore', d: "Tag message to be ignored (regex)"},
        {n: 'tagQuiet', d: "Tag message to be quietly processed (regex)"},
        {n: 'tagFeedback', d: "Tag message to be processed and provide feedback (regex)"},
        {n: 'loudCustomTweak', d: "Allowable customization interval for loudness"}
    ]; }

    get defaults() { return {
        ffmpegPath: null,
        ffprobePath: null,

        downloadPath: "songs",
        minDuration: 90,
        maxDuration: 1500,
        maxDiskUsage: null,
        maxSimDownloads: 2,
        scanDelay: 200,
        
        selfDeleteExpiration: 604800,  //7 days
        permissionsDeleteAll: [],
        permissionsReplace: [],

        allowedFormats: AUDIO_FORMATS,
        defaultFormat: 'mp3',

        defaultBehavior: 'feedback',
        tagIgnore: '^XX',
        tagQuiet: '^\\$\\$',
        tagFeedback: '^!!',
        
        loudCustomTweak: 4
    }; }

    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    get isMultiInstanceable() { return true; }

    get denv() {
        return this.env('Discord');
    }

    constructor(name) {
        super('Grabber', name);
        
        this._preparing = 0;  //Used for generating temporary filenames
        
        this._index = {};  //Main index (hash => info)
        this._indexSourceTypeAndId = {};  //{sourceType: {sourceId: ..., ...}}
        this._indexAlbumAndTrack = {};  //{albumCompacted: {track: ..., ...}}
        this._stats = null;  //{users: {userid: {displayname, shares, shareavglength, ...}, ...}}
        
        this._usage = 0;  //Cache disk usage (by mp3s only)
        this._sessionGrabs = [];  //History of hashes grabbed in this session

        this._hashhelp = [];  //[[filter, description], ...] to display in !song hash
        this._parserFilters = [];  //[[regex, callback(string)], ...] to apply to hashoroffset arguments (see API)
        
        this._scanQueue = [];  //Rate-limit song downloads and other heavy actions. Each item is: ["description", anonymous function that performs the action, cacheurl]
                                //  where cacheurl is an optional cache key used to delay dequeueing while cache is under construction.
        this._scanTimer = null;
        this._downloads = 0;
        
        this._cache = {};  //{url: {ongoinginfo: boolean, info, ongoing: boolean, data}} Temporary cache
        
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        const permAdmin = this.be('Users').defaultPermAdmin;
        const permMod =  this.be('Users').defaultPermMod;

        if (this.param("ffmpegPath")) {
            FFmpeg.setFfmpegPath(this.param("ffmpegPath"));
        }

        if (this.param("ffprobePath")) {
            FFmpeg.setFfprobePath(this.param("ffprobePath"));
        }


        //Load index
        
        this._index = this.loadData(this.param('downloadPath') + '/' + INDEXFILE, {}, {abspath: true, pretty: true, quiet: true});
        if (this._index === false) {
            this.log("error", "Unable to load index file.");
            return false;
        }
        
        for (let hash in this._index) {
            let info = this._index[hash];
            if (!this._indexSourceTypeAndId[info.sourceType]) {
                this._indexSourceTypeAndId[info.sourceType] = {};
            }
            this._indexSourceTypeAndId[info.sourceType][info.sourceSpecificId] = info;

            if (info.album && info.track) {
                let albumCompacted = info.album.replace(/ /g, "").toLowerCase();
                if (!this._indexAlbumAndTrack[albumCompacted]) {
                    this._indexAlbumAndTrack[albumCompacted] = {};
                }
                this._indexAlbumAndTrack[albumCompacted][info.track] = info;
            }
        }

        this.calculateDownloadPathUsage();
        
        
        //Queue processor
        
        this._scanTimer = setInterval(() => {
            this.dequeueAndScan();
        }, this.param('scanDelay'));

      
        //Register callbacks
        
        this.denv.on('message', this.onMessage, this);
        this.denv.on('connected', () => { this.loadStats(); }, this);
        
        
        this.be('Commands').registerRootDetails(this, 'grab', {
            description: "Manage the collection of songs from a Discord channel.",
            details: [
                "Use `song hash` for a list of registered filters for hash or offset arguments."
            ]
        });

        
        this.be('Commands').registerRootDetails(this, 'song', {
            description: "Interact with the song index.",
            details: [
                "Use `song hash` for a list of registered filters for hash or offset arguments."
            ]
        });
        
        
        this.be('Commands').registerCommand(this, 'grab scan', {
            description: 'Scans channel history until INTERVAL days ago and grabs any song files.',
            args: ['channelid', 'interval'],
            environments: ['Discord'],
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let channel = env.server.channels.cache.get(args.channelid);
            if (!channel) return false;
            
            let endNow = false;
            let cutoff = (moment().unix() - args.interval * 86400) * 1000;
            
            ep.reply("Scanning...");
            
            let scanning = null;
            let scanner = () => {
                channel.messages.fetch({
                    limit: 100,
                    before: scanning
                }).then((messages) => {
                    let messagesarr = [...messages.values()];
                    if (messagesarr.length < 100) endNow = true;
                    for (let message of messagesarr) {
                        if (message.createdTimestamp <= cutoff) endNow = true;
                        this.queueScanMessage(message, {
                            exists: (messageObj, messageAuthor, reply, hash) => {
                                this.emit("songExistsOnScan", messageObj, messageAuthor, reply, hash);
                            }
                        });
                    }
                    if (endNow) {
                        ep.reply("Scan complete.");
                    } else {
                        scanning = messagesarr[messagesarr.length - 1].id;
                        setTimeout(scanner, 250);
                    }
                });
            };
            scanner();
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'grab regrab', {
            description: 'Fix the library by attempting to redownload songs from source (if not missing).',
            args: ['hashoroffset', 'format', 'onlyreformat'],
            minArgs: 0,
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (args.hashoroffset) {
            
                let hash = this.parseHashArg(args.hashoroffset);
                if (hash === false) {
                    ep.reply('Offset not found in recent history.');
                    return true;
                } else if (hash === true) {
                    ep.reply('Reference matches more than one song; Please be more specific.');
                    return true;
                } else if (!hash) {
                    ep.reply('Hash not found.');
                    return true;
                }
            
                this.queueRegrab(this._index[hash], args.format, {
                    accepted: (messageObj, a, b, hash) => ep.reply(hash + ": Got it."),
                    errorDuration: (messageObj) => ep.reply(messageObj.hash + ": I only index songs with a duration between " + this.param('minDuration') + " and " + this.param('maxDuration') + " seconds."),
                    errorNotFound: (messageObj) => ep.reply(messageObj.hash + ": the song you tried to replace could not be found."),
                    errorEncoding: (messageObj) => ep.reply(messageObj.hash + ": the song could not be obtained or converted.")
                });
                ep.reply("Regrab requested.");
                return true;
            }
        
            ep.reply("Sit tight, this may take a long time...");
        
            let i = 0;
        
            for (let hash in this._index) {
                let curformat = this._index[hash].format || this.param('defaultFormat');
                if (args.format && args.onlyreformat && curformat == args.format) continue;
                this.queueRegrab(this._index[hash], args.format, {
                    accepted: (messageObj, a, b, hash) => {
                        i += 1;
                        if (!(i % 100)) ep.reply(i + " accepted so far.");
                    },
                    errorDuration: (messageObj) => ep.reply(messageObj.hash + ": I only index songs with a duration between " + this.param('minDuration') + " and " + this.param('maxDuration') + " seconds."),
                    errorNotFound: (messageObj) => ep.reply(messageObj.hash + ": the song you tried to replace could not be found."),
                    errorEncoding: (messageObj) => ep.reply(messageObj.hash + ": the song could not be obtained or converted.")
                });
            }
            
            return true;
        });


        this.be('Commands').registerCommand(this, 'grab analyze', {
            description: 'Analyze songs in the library and update the index.',
            args: ['hashoroffset'],
            minArgs: 0,
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (args.hashoroffset) {

                let hash = this.parseHashArg(args.hashoroffset);
                if (hash === false) {
                    ep.reply('Offset not found in recent history.');
                    return true;
                } else if (hash === true) {
                    ep.reply('Reference matches more than one song; Please be more specific.');
                    return true;
                } else if (!hash) {
                    ep.reply('Hash not found.');
                    return true;
                }

                this.queueAnalyze(this._index[hash], {
                    success: () => {
                        ep.reply(hash + ": Successfully analyzed.");
                    },
                    error: (err) => ep.reply(hash + ": Failed to analyze song.")
                });
                return true;
            }

            ep.reply("Sit tight, this may take a long time...");

            let i = 0;

            for (let hash in this._index) {
                this.queueAnalyze(this._index[hash], {
                    success: () => {
                        i += 1;
                        if (!(i % 100)) ep.reply(i + " accepted so far.");
                    },
                    error: (err) => ep.reply(hash + ": Failed to analyze song.")
                });
            }

            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'grab undo', {
            description: 'Undo a single recent grab from this session.',
            args: ['offset'],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!args.offset || args.offset > -1) args.offset = -1;
        
            if (args.offset < -20) {
                ep.reply('Offset too high. Use grabdelete instead.');
                return true;
            }
        
            if (-args.offset > this._sessionGrabs.length) {
                ep.reply('Offset not found in recent history.');
                return true;
            }

            let info = this._index[this._sessionGrabs[-args.offset - 1][0]];
            if (info) {

                let candeleteall = this.param('permissionsDeleteAll') === true || await this.be('Users').testPermissions(this.denv.name, userid, channelid, this.param('permissionsDeleteAll'));
                let partial = false;

                if (info.seen.length > 1) {
                    info.seen = info.seen.filter((ts) => ts != this._sessionGrabs[-args.offset - 1][1]);
                    partial = true;
                }

                if (!candeleteall) {
                    if (info.sharedBy.length > 1) {
                        info.sharedBy = info.sharedBy.filter((shareid) => shareid != userid);
                        partial = true;
                    } else if (info.sharedBy[0] != userid) {
                        ep.reply("You can only delete your own songs.");
                        return true;
                    }
                }
                
                if (!partial) {
                    if (candeleteall || moment().unix() - info.seen[0] < this.param('selfDeleteExpiration')) {
                        if (!await this.removeByHash(info.hash, candeleteall, userid)) {
                            ep.reply('Hash not found or not removable.');
                            return true;
                        }
                    } else {
                        ep.reply('You can\'t delete this song; it was shared too long ago.');
                        return true;
                    }
                }

                ep.ok();
            } else {
                ep.reply('Historic hash not found in index! I will just remove it from the history.');
            }
            
            this._sessionGrabs.splice(-args.offset - 1, 1);
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'grab delete', {
            description: 'Delete an indexed song by hash.',
            args: ['hashoroffset']
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
                    
            let hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }

            let candeleteall = this.param('permissionsDeleteAll') === true || await this.be('Users').testPermissions(this.denv.name, userid, channelid, this.param('permissionsDeleteAll'));

            if (!candeleteall) {
                let info = this._index[hash];
                if (info.sharedBy.length > 1) {
                    info.sharedBy = info.sharedBy.filter((shareid) => shareid != userid);
                    ep.ok();
                    return true;
                } else if (info.sharedBy[0] != userid) {
                    ep.reply("You can only delete your own songs.");
                    return true;
                } else if (moment().unix() - info.seen[0] < this.param('selfDeleteExpiration')) {
                    ep.reply('You can\'t delete this song; it was shared too long ago.');
                    return true;
                }
            }
                    
            if (await this.removeByHash(hash, candeleteall, userid)) {
                this._sessionGrabs = this._sessionGrabs.filter((item) => item[0] != hash);
                ep.ok();
            } else {
                ep.reply('Hash not found or not removable.');
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'grab latest', {
            description: 'Get the hash of a single recent song.',
            args: ['hashoroffset'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let hash = this.parseHashArg(args.hashoroffset, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
            
            ep.reply('`#' + hash + '`');
            
            return true;
        });


        this.be('Commands').registerCommand(this, 'grab tasks', {
            description: 'Lists the contents of the scan queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._scanQueue.length) {
                ep.reply('The queue is empty.');
                return true;
            }

            ep.reply("```");
            for (let i = 0; i < this._scanQueue.length; i++) {
                let width = String(this._scanQueue.length).length;
                let pos = ('0'.repeat(width) + String(i+1)).slice(-width);
                ep.reply('[' + pos + '] ' + this._scanQueue[i][0]);
            }
            ep.reply("```");
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'grab reformat', {
            description: 'Convert a cached song to a different format.',
            details: [
                'This operation is lossy if the song is converted to a lossy format.'
            ],
            args: ['hashoroffset', 'format'],
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            let hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
            
            if (AUDIO_FORMATS.indexOf(args.format) < 0) {
                ep.reply('Format not found.');
                return true;
            }
        
            this.queueReformat(this._index[hash], args.format, {
                success: (newsong) => ep.reply("`#" + newsong.hash + "`: Reformat from " + hash + "."),
                error: (oldsong, err) => ep.reply("`#" + oldsong.hash + "`: Failed reformat: " + err)
            });

            ep.reply("Reformat requested.");
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song hash', {
            description: 'Lists filters accepted in hash or offset arguments of song and grab commands.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            ep.reply("  `#HASH` : References the song uniquely identified by HASH.")
            ep.reply("  `-NUMBER` : References latest learned song or a recently learned song (NUMBER songs ago).");

            for (let item of this._hashhelp) {
                ep.reply("  `" + item[0] + "` : " + item[1]);
            }

            ep.reply("  `?Any string` : Performs a search by string and returns the hash of a random result.");
            ep.reply("  `Any string` : Performs a search by string and returns a hash if and only if there is exactly one result.");

            return true;
        });

        this.be('Commands').registerCommand(this, 'song find', {
            description: 'Find an indexed song.',
            details: [
                'Use -p PAGE before the search string to access result pages beyond the first one (if available).',
                'You can filter by multiple independent search strings by using SEARCHSTR & SEARCHSTR & ...'
            ],
            args: ['searchstr', true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let page = 0;
            let searchstr = args.searchstr;
            
            if (searchstr[0] == '-p' && !isNaN(parseInt(searchstr[1]))) {
                if (parseInt(searchstr[1]) >= 0) {
                    page = parseInt(searchstr[1]);
                    searchstr.shift();
                    searchstr.shift();
                }
            }
            
            searchstr = searchstr.join(' ');
        
            let results = this.filterSongsBySearchString(searchstr);
            if (!results.length) {
                ep.reply("No results.");
            }
            
            let ltotal = results.length;
            results = results.slice(page * 10, page * 10 + 10);
            
            if (!results.length) {
                ep.reply('Found ' + ltotal + ' result' + (ltotal != 1 ? 's' : '') + '.');
            } else {
                ep.reply('Result' + (results.length != 1 ? 's' : '') + ' ' + (page * 10 + 1) + ' to ' + (page * 10 + results.length) + ' of ' + ltotal + '.');
                for (let info of results) {
                    ep.reply('`#' + info.hash + ' ' + info.name + (info.author ? ' (' + info.author + ')' : '') + '`');
                }
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song set', {
            description: 'Change metadata of an indexed song.',
            details: [
                "Allowed fields: " + SET_FIELDS.join(', ')
            ],
            args: ['hashoroffset', 'field', 'value', true],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let hash = this.parseHashArg(args.hashoroffset, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (SET_FIELDS.indexOf(args.field) < 0) {
                ep.reply("Invalid field name.");
                return true;
            }
            
            let newvalue = args.value.join(' ');
            
            if (NUMBER_FIELDS.indexOf(args.field) > -1) {
                newvalue = parseInt(newvalue);
                if (isNaN(newvalue)) {
                    ep.reply("This field must be numeric.");
                    return true;
                }
            }

            //-----Logic for indexAlbumAndTrack
            let entry = this._index[hash];

            if (entry.album && args.field == "track") {
                let albumCompacted = entry.album.replace(/ /g, "").toLowerCase();
                if (!this._indexAlbumAndTrack[albumCompacted]) {
                    this._indexAlbumAndTrack[albumCompacted] = {};
                }
                if (entry.track !== undefined) {
                    delete this._indexAlbumAndTrack[albumCompacted][entry.track];
                }
                this._indexAlbumAndTrack[albumCompacted][newvalue] = entry;
            }

            if (entry.track !== undefined && args.field == "album") {
                let albumCompacted = entry.album.replace(/ /g, "").toLowerCase();
                if (this._indexAlbumAndTrack[albumCompacted] && this._indexAlbumAndTrack[albumCompacted][entry.track]) {
                    delete this._indexAlbumAndTrack[albumCompacted][entry.track];
                }
                if (newvalue) {
                    let newAlbumCompacted = newvalue.replace(/ /g, "").toLowerCase();
                    if (!this._indexAlbumAndTrack[newAlbumCompacted]) {
                        this._indexAlbumAndTrack[newAlbumCompacted] = {};
                    }
                    this._indexAlbumAndTrack[newAlbumCompacted][newvalue] = entry;
                }
            }
            //-----
            
            this._index[hash][args.field] = newvalue;
            this._index.save();
            
            ep.ok();
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song get', {
            description: 'Retrieve metadata of an indexed song.',
            details: [
                "Allowed fields: " + GET_FIELDS.join(', ')
            ],
            args: ['hashoroffset', 'field']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let hash = this.parseHashArg(args.hashoroffset, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (GET_FIELDS.indexOf(args.field) < 0) {
                ep.reply("Invalid field name.");
                return true;
            }
            
            let result = this._index[hash][args.field];
            if (typeof result == "object") {
                if (result.join) result = result.join(", ");
                else result = "";
            }
            
            ep.reply(result);
            
            return true;
        });


        this.be('Commands').registerCommand(this, 'song album', {
            description: 'Retrieve tracks by album.',
            args: ['album', true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let albumCompacted = args.album.join("").toLowerCase();
            if (!this._indexAlbumAndTrack[albumCompacted] || Object.keys(this._indexAlbumAndTrack[albumCompacted]).length == 0) {
                ep.reply("Album not found or not indexed.");
                return true;
            }

            for (let track in this._indexAlbumAndTrack[albumCompacted]) {
                let entry = this._indexAlbumAndTrack[albumCompacted][track];
                ep.reply("`#" + entry.hash + " " + track + ": " + entry.name + (entry.author ? ' (' + entry.author + ')' : '') + "`");
            }
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song kw', {
            description: 'List keywords associated with an indexed song.',
            args: ['hashoroffset'],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let hash = this.parseHashArg(args.hashoroffset, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            ep.reply("Keywords: " + this._index[hash].keywords.join(', '));
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song kw add', {
            description: 'Associate a new keyword with an indexed song.',
            args: ['hashoroffset', 'keyword', true],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            args.keyword = args.keyword.join(" ");
        
            let hash = this.parseHashArg(args.hashoroffset, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (!this._index[hash].keywords || typeof this._index[hash].keywords != "object") {
                this._index[hash].keywords = [];
            }
        
            if (this._index[hash].keywords.indexOf(args.keyword) < 0) {
                this._index[hash].keywords.push(args.keyword);
                this._index.save();
                ep.ok();
            } else {
                ep.reply("Already existed.");
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'song kw remove', {
            description: 'Remove a keyword from an indexed song.',
            args: ['hashoroffset', 'keyword', true],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            args.keyword = args.keyword.join(" ");
        
            let hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (!this._index[hash].keywords || typeof this._index[hash].keywords != "object") {
                this._index[hash].keywords = [];
            }
        
            let ind = this._index[hash].keywords.indexOf(args.keyword);
            if (ind > -1) {
                this._index[hash].keywords.splice(ind, 1);
                this._index.save();
                ep.ok();
            } else {
                ep.reply("Doesn't exist.");
            }
        
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    //Stats file manipulation
    
    async loadStats() {
        if (this._stats) return true;
        
        //This file is rebuilt every time we start the module.
        
        this._stats = {users: {}};

        let shareavglength = {};
        let sharemaxlength = {};
        let shareminlength = {};
        
        for (let hash in this._index) {
            let info = this._index[hash];
            for (let sharer of info.sharedBy) {
                await this.incrUserStat(sharer, "shares", 1, true);
                if (!shareavglength[sharer]) shareavglength[sharer] = 0;
                shareavglength[sharer] += info.length;
                if (!sharemaxlength[sharer]) sharemaxlength[sharer] = info.length; else sharemaxlength[sharer] = Math.max(sharemaxlength[sharer], info.length);
                if (!shareminlength[sharer]) shareminlength[sharer] = info.length; else shareminlength[sharer] = Math.min(shareminlength[sharer], info.length);
            }
        }
        
        for (let sharer in shareavglength) {
            await this.setUserStat(sharer, "shareavglength", shareavglength[sharer] / this.getUserStat(sharer, "shares"), true);
            await this.setUserStat(sharer, "shareminlength", shareminlength[sharer], true);
            await this.setUserStat(sharer, "sharemaxlength", sharemaxlength[sharer], true);
        }
        
        this.saveStats();
        
        return true;
    }
    
    saveStats() {
        this.saveData(this.param('downloadPath') + '/' + STATSFILE, this._stats, {abspath: true, pretty: true, quiet: true});
    }
    
    
    //Message processing
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (this.param('channels').indexOf(channelid) < 0) return false;
        this.queueScanMessage(rawobj, {
            accepted: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply("Got it, " + messageAuthor + " (`#" + hash + "`).");
            },
            exists: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply(messageAuthor + ", the song was already known (`#" + hash + "`).");
            },
            errorDuration: (messageObj, messageAuthor, reply, label) => {
                if (reply) reply(messageAuthor + ", I only index songs with a duration between " + this.param('minDuration') + " and " + this.param('maxDuration') + " seconds" + (label ? " (" + label + ")" : "") + ".");
            },
            errorPermission: (messageObj, messageAuthor, reply) => {
                if (reply) reply(messageAuthor + ", you don't have permission to do that!");
            },
            errorNotFound: (messageObj, messageAuthor, reply) => {
                if (reply) reply(messageAuthor + ", the song you tried to replace could not be found.");
            },
            errorEncoding: (messageObj, messageAuthor, reply) => {
                if (reply) reply(messageAuthor + ", the song could not be obtained or converted.");
            }
        });
    }
    
    
    extractMessageInfo(message, meta) {
        let warnauthor = this.param('defaultBehavior') == 'feedback';
        let noextract =  this.param('defaultBehavior') == 'ignore';

        if (message.match(new RegExp(this.param('tagQuiet')))) {
            noextract = false;
            warnauthor = false;
        }
        if (message.match(new RegExp(this.param('tagFeedback')))) {
            noextract = false;
            warnauthor = true;
        }
        if (message.match(new RegExp(this.param('tagIgnore')))) {
            noextract = true;
            warnauthor = false;
        }
    
        let dkeywords = message.match(/\[[A-Za-z0-9\u{3040}-\u{D7AF}\(\)' _-]+\]/gu);
        if (!dkeywords) dkeywords = [];
        dkeywords = dkeywords.map((item) => {
            let ikeyword = item.match(/^\[([^\]]+)\]$/u);
            if (!ikeyword) return null;
            return ikeyword[1];
        }).filter((item) => item);
        
        let title = message.match(/\{(title|name|song|n)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' .!?:;,_-]+)\}/iu);
        if (title) title = title[3];
        let artist = message.match(/\{(author|artist|band|creator|c)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' .!?:;,_-]+)\}/iu);
        if (artist) artist = artist[3];
        let album = message.match(/\{(album|a)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' .!?:;,_-]+)\}/iu);
        if (album) album = album[3];
        let track = message.match(/\{(track|t)(=|:) ?([0-9]{1,3})\}/iu);
        if (track) track = parseInt(track[3]);
        
        let replace = message.match(/\{replace(=|:) ?#?([0-9A-Fa-f]+)\}/iu);
        if (replace) replace = replace[2];
        
        let interval = null;
        if (title || replace) {
            interval = message.match(/<(([0-9:]+)?(,[0-9:]+)?)>/);
            if (interval) {
                interval = this.parseInterval(interval[1]);
            } 
        }
        if (!interval) {
            let chapter = null;
            let chapterno = message.match(/<C([0-9]+)>/);
            if (chapterno && chapterno[1] <= meta.chapters.length) {
                chapter = meta.chapters[chapterno[1] - 1];
                if (!track) track = parseInt(chapterno[1]);
            } else {
                let chaptername = message.match(/<([^>]{3,})>/);
                if (chaptername && chaptername[1] != "ALL" && chaptername[1] != "FILL") {
                    chaptername = chaptername[1].toLowerCase().trim();
                    let i = 1;
                    for (let checkchapter of meta.chapters) {
                        if (checkchapter.title.toLowerCase().trim().indexOf(chaptername) > -1) {
                            chapter = checkchapter;
                            if (!track) track = i;
                            break;
                        }
                        i += 1;
                    }
                }
            }
            if (chapter) {
                interval = [chapter.start_time, chapter.end_time];
                if (!title) title = chapter.title;
            }
        }
        
        let all = !interval && meta.chapters.length && message.match(/<ALL>/);
        let fill = !interval && meta.chapters.length && message.match(/<FILL>/);
        if ((all || fill) && replace) {
            replace = null;
        }
        
        let format = this.param('defaultFormat');
        let getformat = message.match(new RegExp("\\{format(=|:) ?(" + this.param("allowedFormats").join("|") + ")\\}", "iu"));
        if (getformat) {
            if (AUDIO_FORMATS.indexOf(getformat[2]) > -1 && this.param("allowedFormats").find(getformat[2])) {
                format = getformat[2];
            }
        }
        if (AUDIO_FORMATS.indexOf(format) < 0) format = 'mp3';

        let tweak = 0;
        let gettweak = message.match(/\{tweak(=|:) ?(-?[0-9]{1,2})\}/iu);
        if (gettweak) tweak = parseInt(gettweak[2]);
        
        return {
            warnauthor: warnauthor,
            noextract: noextract,
            keywords: dkeywords,
            title: title,
            artist: artist,
            album: album,
            track: track,
            replace: replace,
            interval: interval,
            format: format,
            tweak: tweak,
            all: all,
            fill: fill
        };
    }
    
    
    async obtainMessageParams(messageObj, fragment, from, url) {
        if (messageObj.regrab) {
            //messageObj is already local song metadata
            return {
                regrab: messageObj,
                author: null,
                authorName: '',
                info: {
                    warnauthor: false,
                    noextract: false,
                    keywords: [],
                    title: null,
                    artist: null,
                    album: null,
                    track: null,
                    replace: messageObj.hash,
                    interval: messageObj.sourcePartial,
                    format: messageObj.format,
                    tweak: messageObj.tweak || 0
                },
                interval: messageObj.sourcePartial,
                reply: null
            }
        }
    
        let chapters = [];
        if (from == 'youtube') {
            try {
                chapters = await this.youtubeChapters(url);
            } catch (e) {
                this.log('warn', 'Chapter extraction: ' + e);
            }
        }
    
        let messageInfo = this.extractMessageInfo(fragment, {authorid: messageObj.author.id, chapters: chapters});

        if (messageInfo.replace) {
            if (!(this.param('permissionsReplace') === true || await this.be('Users').testPermissions(this.denv.name, messageObj.author.id, messageObj.channel.id, this.param('permissionsReplace')))) {
                messageInfo.replace = false;
            }
        }
        
        return {
            author: messageObj.author.id,
            authorName: await this.denv.idToDisplayName(messageObj.author.id),
            info: messageInfo,
            interval: messageInfo.interval,
            reply: (messageInfo.warnauthor ? (out) => { this.denv.msg(messageObj.channel.id, out)} : null),
            chapters: chapters
        };
    }

    duplicateMessageParams(mp) {
        let copy = Object.assign({}, mp);
        copy.info = Object.assign({}, copy.info);
        return copy;
    }
    
    /* Callbacks:
        accepted(messageObj, messageAuthor, reply, hash) - The song has just been indexed as a result of this call (details can be retrieved from the index)
        exists(messageObj, messageAuthor, reply, hash) - A song already existed (details can be retrieved from the index)
        errorDuration(messageObj, messageAuthor, reply, label) - A song fails a duration check
        errorPermission(messageObj, messageAuthor, reply) - The song could not be collected because its metadata violated a permission check
        errorNotFound(messageObj, messageAuthor, reply) - The targeted song was not found in the index
        reply is either a function for replying to the environment (if the message is tagged for feedback) or null
    */
    grabInMessage(messageObj, callbacks, readOnly) {
        let fragments = messageObj.content.split(/\{\+\}/iu);
        if (fragments.length == 1) {
            this.grabInFragment(messageObj, fragments[0], callbacks, readOnly, true);
        } else {
            for (let fragment of fragments) {
                this._scanQueue.push(["Scan fragment", function() {
                    this.grabInFragment(messageObj, fragment, callbacks, readOnly, false);
                }.bind(this)]);
            }
        }
    }

    async grabInFragment(messageObj, fragment, callbacks, readOnly, single) {
        if (this.isDownloadPathFull() || !messageObj) return false;

        //Youtube
        let yturls = fragment.match(/(?:https?:\/\/|\/\/)?(?:www\.|m\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11}|[\w_-]{12})(?![\w_-])/g);
        if (yturls) {
            for (let url of yturls) {
                let mp = await this.obtainMessageParams(messageObj, fragment, 'youtube', url);
                if (mp.info.all || mp.info.fill) {
                    //All chapters
                    for (let i = 0; i < mp.chapters.length; i++) {
                        let chapter = mp.chapters[i];
                        
                        let cmp = this.duplicateMessageParams(mp);
                        cmp.info.title = chapter.title;
                        let fixtitle = cmp.info.title.match(/^[0-9]+[:.-] ?(.+)/);
                        if (fixtitle) cmp.info.title = fixtitle[1];
                        cmp.info.track = i + 1;
                        cmp.info.interval = [chapter.start_time, chapter.end_time];
                        cmp.interval = cmp.info.interval;
                        delete cmp.chapters;

                        if (cmp.info.album) {
                            let albumCompacted = cmp.info.album.replace(/ /g, "").toLowerCase();
                            if (this._indexAlbumAndTrack[albumCompacted] && this._indexAlbumAndTrack[albumCompacted][cmp.info.track]) {
                                if (cmp.info.fill) {
                                    continue;
                                }
                                if (cmp.info.all) {
                                    cmp.info.replace = this._indexAlbumAndTrack[albumCompacted][cmp.info.track].hash;
                                }
                            }
                        }

                        this._scanQueue.push(["Grab from Youtube", function() {
                            this.grabFromYoutube(cmp, url, messageObj, callbacks, readOnly)
                                .catch((e) => this.log('warn', 'Grab from YouTube: ' + e));
                        }.bind(this), url]);
                    }
                    this._scanQueue.push(["Clear cache", function() {
                        this.clearCache();
                    }.bind(this)]);
                } else {
                    this._scanQueue.push(["Grab from Youtube", function() {
                        this.grabFromYoutube(mp, url, messageObj, callbacks, readOnly)
                            .catch((e) => this.log('warn', 'Grab from YouTube: ' + e));
                    }.bind(this), url]);
                    this._scanQueue.push(["Clear cache", function() {
                        this.clearCache();
                    }.bind(this)]);
                }
            }
        }
        
        //Attachment
        if (single && messageObj.attachments && messageObj.attachments.size) {
            for (let ma of messageObj.attachments.values()) {
                if (!ma.name || !ma.name.match(/\.(mp3|ogg|flac|wav|pcm|wma|aac|m4a)$/) || ma.size < 20480) continue;
                let mp = await this.obtainMessageParams(messageObj, fragment);
                this._scanQueue.push(["Grab from Attachment", function() {
                    this.grabFromAttachment(mp, ma, messageObj, callbacks, readOnly)
                        .catch((e) => this.log('warn', 'Grab from attachment: ' + e));
                }.bind(this)]);
            }
        }
        
        //Google Drive
        let gdurl = fragment.match(/(?:https?:\/\/|\/\/)?(?:drive|docs)\.google\.com\/(?:(?:open|uc)\?id=|file\/d\/)([\w_-]{28,})(?![\w_])/);
        if (gdurl) {
            let mp = await this.obtainMessageParams(messageObj, fragment);
            gdurl = 'https://docs.google.com/uc?id=' + gdurl[1];
            this._scanQueue.push(["Grab from URL", function() {
                this.grabFromURL(mp, gdurl, 'gdrive', gdurl[1], messageObj, callbacks, readOnly)
                    .catch((e) => this.log('warn', 'Grab from Google Drive URL: ' + e));
            }.bind(this)]);
        }
        
        //Dropbox
        let dburl = fragment.match(/(?:https?:\/\/|\/\/)?(?:www\.)?dropbox\.com\/s\/([\w_]{15,})(?![\w_])/);
        if (dburl) {
            let mp = await this.obtainMessageParams(messageObj, fragment);
            dburl = 'https://www.dropbox.com/s/' + dburl[1] + '/?dl=1';
            this._scanQueue.push(["Grab from URL", function() {
                this.grabFromURL(mp, dburl, 'dropbox', dburl[1], messageObj, callbacks, readOnly)
                    .catch((e) => this.log('warn', 'Grab from Dropbox URL: ' + e));
            }.bind(this)]);
        }
        
        return true;
    }
    
    reGrab(info, format, callbacks, readOnly) {
        if (this.isDownloadPathFull() || !info) return false;
        
        info = Object.assign({}, info);
        info.regrab = true;
        if (format) info.format = format;
        
        if (info.sourceType == 'youtube') {
            this.grabFromYoutube(info.source, info, callbacks, readOnly)
                .catch((e) => this.log('warn', 'Regrab from YouTube: ' + e));
        } else if (info.sourceType == 'discord') {
            this.grabFromAttachment({name: info.name, id: info.sourceSpecificId, url: info.source}, info, callbacks, readOnly)
                .catch((e) => this.log('warn', 'Regrab from attachment: ' + e));
        } else if (info.source) {
            this.grabFromURL(info.source, info.sourceType, info.sourceSpecificId, info, callbacks, readOnly)
                .catch((e) => this.log('warn', 'Regrab from URL: ' + e));
        }
        
        return true;
    }


    clearCache(url) {
        if (this._cache[url]) {
            delete this._cache[url];
        }
    }

    youtubeInfo(url) {
        if (!this._cache[url]) {
            this._cache[url] = {
                ongoinginfo: false,
                info: null,
                ongoing: false,
                data: null
            };
        }
        if (this._cache[url].info) {
            return Promise.resolve(this._cache[url].info);
        } else {
            this._cache[url].ongoinginfo = true;
            return ytdl.getInfo(url)
                .then((info) => {
                    this._cache[url].info = info;
                    this._cache[url].ongoinginfo = false;
                    return info;
                });
        }
    }

    async youtubeChapters(url) {
        let info = await this.youtubeInfo(url);
        let chapters = info.videoDetails?.chapters || [];
        for (let i = 0; i < chapters.length - 1; i++) {
            chapters[i].end_time = chapters[i + 1].start_time;
        }
        if (chapters.length) {
            chapters[chapters.length - 1].end_time = parseInt(info.videoDetails?.lengthSeconds);
        }
        return chapters;
    }

    youtubeDownload(url) {
        if (!this._cache[url]) {
            this._cache[url] = {
                ongoinginfo: false,
                info: null,
                ongoing: false,
                data: null
            };
        }
        if (this._cache[url].data) {
            let stream = new Readable({});
            stream.push(this._cache[url].data);
            stream.push(null);
            return stream;
        } else if (!this._cache[url].ongoing) {
            this._cache[url].ongoing = true;
            this._cache[url].data = [];
            let stream = ytdl(url, {filter: 'audioonly'});
            stream.on("data", (data) => {
                this._cache[url].data.push(data);
            });
            stream.on("end", () => {
                this._cache[url].data = Buffer.concat(this._cache[url].data);
                this._cache[url].ongoing = false;
            });
            return stream;
        }
    }
    
    async grabFromYoutube(mp, url, messageObj, callbacks, readOnly) {
        if (mp.info.noextract) return;

        let downloading = false;

        //Obtain metadata from youtube
        this.youtubeInfo(url)
            .then((info) => {
            
                let videoId = info.videoDetails.videoId || info.player_response.videoDetails.videoId;
                let length = info.videoDetails.lengthSeconds || info.player_response.videoDetails.lengthSeconds || 0;
                
                if (mp.interval && mp.interval[1] > length) {
                    mp.interval[1] = length;
                }
                
                if (!mp.interval && length < this.param('minDuration') || mp.interval && mp.interval[1] - mp.interval[0] < this.param('minDuration')
                        || length > this.param('maxDuration') && (!mp.interval || mp.interval[1] - mp.interval[0] > this.param('maxDuration'))) {
                    if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.videoDetails.title);
                    return;
                }
                        
                if (!mp.regrab && this._indexSourceTypeAndId['youtube'] && this._indexSourceTypeAndId['youtube'][videoId]
                        && !this._indexSourceTypeAndId['youtube'][videoId].sourcePartial && !mp.interval) {
                    if (callbacks.exists) callbacks.exists(messageObj, mp.authorName, mp.reply, this._indexSourceTypeAndId['youtube'][videoId].hash);
                    return;
                }
                
                let keywords = [];
                if (typeof info.videoDetails?.keywords === "object") {
                    for (let keyword of info.videoDetails.keywords) {
                        keywords.push(keyword);
                    }
                }
                for (let dkeyword of mp.info.keywords) {
                    keywords.push(dkeyword);
                }
                
                let loudness = null;
                if (typeof info.player_response?.playerConfig?.audioConfig === "object") {
                    loudness = parseFloat(info.player_response.playerConfig.audioConfig.perceptualLoudnessDb);
                }
                
                this.log('Grabbing from youtube: ' + url);
                this._downloads += 1;
                downloading = true;
            
                //Youtube -> FFmpeg -> Hard drive
                
                let video = this.youtubeDownload(url);
                
                let ffmpeg = new FFmpeg(video);
                if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
                
                let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                let stream = fs.createWriteStream(temppath);

                if (mp.info.format == 'pcm') {
                    ffmpeg.format('s16le').audioBitrate('48k').audioChannels(2);
                } else if (mp.info.format == 'flac') {
                    ffmpeg.format('flac');
                } else {
                    ffmpeg.format('mp3');
                }
                let audio = ffmpeg.pipe(stream);
                
                ffmpeg.on('error', (error) => {
                    this.log('error', '[Youtube, FFmpeg] ' + error);
                    audio.destroy();
                    this._downloads -= 1;
                });
                
                stream.on('error', (error) => {
                    this.log('error', '[Youtube, Write] ' + error);
                    audio.destroy();
                    this._downloads -= 1;
                });
            
                stream.on('finish', () => {
                    this._downloads -= 1;
                    video.resume();
                    
                    this.persistTempDownload(temppath, url, mp, {
                        length: parseInt(length),
                        source: url,
                        sourceType: 'youtube',
                        sourceSpecificId: videoId,
                        sourceLoudness: loudness,
                        name: info.videoDetails.title,
                        author: '',
                        album: '',
                        keywords: keywords
                    }, messageObj, callbacks, readOnly);
                });
                
            })
            .catch((err) => {
                this.log('warn', err);
                if (downloading) this._downloads -= 1;
            });
    }
        
    
    async grabFromAttachment(mp, ma, messageObj, callbacks, readOnly) {
        if (mp.info.noextract) return;

        this.log('Grabbing from attachment: ' + ma.name + ' (' + ma.id + ')');
        this._downloads += 1;
        
        let prepnum = this._preparing++;
        
        //Attachment -> Hard drive
        
        let attfiledl = this.streamget(ma.url);
        let prepath = this.param('downloadPath') + '/' + 'dl_' + prepnum + '_a.tmp';
        let prestream = fs.createWriteStream(prepath);
        
        attfiledl.on('error', (error) => {
            this.log('error', '[Attachment, Download] ' + error);
            attfiledl.destroy();
            this._downloads -= 1;
        });
        
        prestream.on('error', (error) => {
            this.log('error', '[Attachment, Write] ' + error);
            attfiledl.destroy();
            this._downloads -= 1;
        });
        
        attfiledl.pipe(prestream);
        
        prestream.on('finish', () => {
        
            //Get song info
            FFmpeg(prepath).ffprobe((err, info) => {
                if (err) {
                    this.log('warn', err);
                    return;
                }
        
                if (mp.interval && mp.interval[1] > info.format.duration) {
                    mp.interval[1] = info.format.duration;
                }
        
                //Hard drive -> FFmpeg -> Hard drive
        
                let ffmpeg = new FFmpeg(prepath);
                if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
                
                let temppath = this.param('downloadPath') + '/' + 'dl_' + prepnum + '.tmp';
                let stream = fs.createWriteStream(temppath);
                
                if (mp.info.format == 'pcm') {
                    ffmpeg.format('s16le').audioBitrate('48k').audioChannels(2);
                } else if (mp.info.format == 'flac') {
                    ffmpeg.format('flac');
                } else {
                    ffmpeg.format('mp3');
                }
                let audio = ffmpeg.pipe(stream);
                
                ffmpeg.on('error', (error) => {
                    this.log('error', '[Attachment, FFmpeg] ' + error);
                    audio.destroy();
                    this._downloads -= 1;
                });
                
                stream.on('error', (error) => {
                    this.log('error', '[Attachment, Rewrite] ' + error);
                    audio.destroy();
                    this._downloads -= 1;
                });

                stream.on('finish', () => {
                    this._downloads -= 1;
                    
                    fs.unlink(prepath, (err) => {});
    
                    let duration = parseFloat(info.format.duration || info.streams[0].duration);
                    if (duration < this.param('minDuration') || duration > this.param('maxDuration')) {
                        if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                        return;
                    }
                    
                    let title = ma.name;
                    let artist = '';
                    let album = '';
                    let track = null;
                    if (info.format && info.format.tags) {
                        if (info.format.tags.title) title = info.format.tags.title;
                        if (info.format.tags.artist) artist = info.format.tags.artist;
                        if (info.format.tags.album) album = info.format.tags.album;
                        if (info.format.tags.track) track = parseInt(info.format.tags.track);
                    }
                    
                    let keywords = (mp.info.dkeywords || []);
                    
                    this.persistTempDownload(temppath, ma.name, mp, {
                        length: Math.floor(duration),
                        source: ma.url,
                        sourceType: 'discord',
                        sourceSpecificId: ma.id,
                        sourceLoudness: null,
                        name: title,
                        author: artist,
                        album: album,
                        track: track,
                        keywords: keywords
                    }, messageObj, callbacks, readOnly);
                });
                
            });
            
        });
    }
    
    
    async grabFromURL(mp, url, sourceType, sourceSpecificId, messageObj, callbacks, readOnly) {
        if (mp.info.noextract) return;

        let filename = sourceSpecificId;
    
        this.log('Grabbing from ' + sourceType + ' URL: ' + url + ' (' + sourceSpecificId + ')');
        this._downloads += 1;
        
        let prepnum = this._preparing++;
        
        //URL -> Hard drive
        
        let filedl = this.streamget(url);
        let prepath = this.param('downloadPath') + '/' + 'dl_' + prepnum + '_a.tmp';
        let prestream = fs.createWriteStream(prepath);
        
        filedl.on('error', (error) => {
            this.log('error', '[URL, Download] ' + error);
            filedl.destroy();
            this._downloads -= 1;
        });
        
        prestream.on('error', (error) => {
            this.log('error', '[URL, Write] ' + error);
            filedl.destroy();
            this._downloads -= 1;
        });
        
        filedl.pipe(prestream);
        
        filedl.on('response', (response) => {
        
            if (response.headers['content-disposition']) {
                let getfilename = response.headers['content-disposition'].match(/filename="([^"]+)"/);
                if (getfilename) filename = getfilename[1];
            }
        
            prestream.on('finish', () => {
        
                //Get song info
                FFmpeg(prepath).ffprobe((err, info) => {
                    if (err) {
                        this.log('warn', err);
                        return;
                    }
                    
                    if (mp.interval && mp.interval[1] > info.format.duration) {
                        mp.interval[1] = info.format.duration;
                    }
                    
                    //Hard drive -> FFmpeg -> Hard drive
                    
                    let ffmpeg = new FFmpeg(prepath);
                    if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
                    
                    let temppath = this.param('downloadPath') + '/' + 'dl_' + prepnum + '.tmp';
                    let stream = fs.createWriteStream(temppath);
                    
                    if (mp.info.format == 'pcm') {
                        ffmpeg.format('s16le').audioBitrate('48k').audioChannels(2);
                    } else if (mp.info.format == 'flac') {
                        ffmpeg.format('flac');
                    } else {
                        ffmpeg.format('mp3');
                    }
                    let audio = ffmpeg.pipe(stream);
                    
                    ffmpeg.on('error', (error) => {
                        this.log('error', '[URL, FFmpeg] ' + error);
                        audio.destroy();
                        this._downloads -= 1;
                    });
                    
                    stream.on('error', (error) => {
                        this.log('error', '[URL, Rewrite] ' + error);
                        audio.destroy();
                        this._downloads -= 1;
                    });
                    
                    stream.on('finish', () => {
                        this._downloads -= 1;
                        
                        fs.unlink(prepath, (err) => {});

                        let duration = parseFloat(info.format.duration || info.streams[0].duration);
                        if (duration < this.param('minDuration') || duration > this.param('maxDuration')) {
                            if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                            return;
                        }
                        
                        let title = filename;
                        let artist = '';
                        let album = '';
                        let track = null;
                        if (info.format && info.format.tags) {
                            if (info.format.tags.title) title = info.format.tags.title;
                            if (info.format.tags.artist) artist = info.format.tags.artist;
                            if (info.format.tags.album) album = info.format.tags.album;
                            if (info.format.tags.track) track = parseInt(info.format.tags.track);
                        }
                        
                        let keywords = (mp.info.dkeywords || []);
                        
                        this.persistTempDownload(temppath, url, mp, {
                            length: Math.floor(duration),
                            source: url,
                            sourceType: sourceType,
                            sourceSpecificId: sourceSpecificId,
                            sourceLoudness: null,
                            name: title,
                            author: artist,
                            album: album,
                            track: track,
                            keywords: keywords
                        }, messageObj, callbacks, readOnly);
                    });
                    
                });
            
            });
            
        });
            
    }
    
    
    /*
        temppath: Temporary location of downloaded song, already in mp3 format.
        originalname: Display name of the original for the downloaded song, for logging.
        mp: Result of this.obtainMessageParams
        info: Source-specific information for bootstrapping index fields. Must contain at least {source, sourceType, sourceSpecificId}
        messageObj, callbacks, readOnly: As passed to grabInMessage.
    */
    async persistTempDownload(temppath, originalname, mp, info, messageObj, callbacks, readOnly) {
        
        //Compute hash
        let data = await promisify(fs.readFile)(temppath);
            
        let hash = crypto.createHash('md5').update(data).digest('hex');
        let realpath = this.param('downloadPath') + '/' + hash + '.' + mp.info.format;
        
        let now = moment().unix();
        
        //Bunch of failure conditions
        if (fs.existsSync(realpath)) {
            fs.unlink(temppath, (err) => {});
            this.log('  Already existed: ' + originalname + '  (as `#' + hash + '`)');
            if (!readOnly && !mp.regrab) {
                this._index[hash].seen.push(now);
                if (this._index[hash].sharedBy.indexOf(mp.author) < 0) {
                    this._index[hash].sharedBy.push(mp.author);
                    
                    let shares = this.getUserStat(mp.author, "shares");
                    await this.setUserStat(mp.author, "shareavglength", (this.getUserStat(mp.author, "shareavglength") * shares + info.length) / (shares + 1));
                    await this.setUserStat(mp.author, "shareminlength", Math.min(this.getUserStat(mp.author, "shareminlength") || 0, info.length));
                    await this.setUserStat(mp.author, "sharemaxlength", Math.max(this.getUserStat(mp.author, "sharemaxlength") || Number.MAX_VALUE, info.length));
                    await this.incrUserStat(mp.author, "shares");
                }
                this._index.save();
            }
            if (callbacks.exists) callbacks.exists(messageObj, mp.authorName, mp.reply, hash);
            return;
        } else if (data.toString().trim() == "") {
            this.log('  Temp file is empty: ' + hash);
            if (callbacks.errorEncoding) callbacks.errorEncoding(messageObj, mp.authorName, mp.reply);
            fs.unlink(temppath, (err) => {});
            return;
        } else if (mp.info.replace === false) {
            this.log('  No permission to commit replacement: ' + hash);
            if (callbacks.errorPermission) callbacks.errorPermission(messageObj, mp.authorName, mp.reply);
            fs.unlink(temppath, (err) => {});
            return;
        } else if (mp.info.replace && !this._index[mp.info.replace]) {
            this.log('  Target of replacement (' + mp.info.replace + ') not found for: ' + hash);
            if (callbacks.errorNotFound) callbacks.errorNotFound(messageObj, mp.authorName, mp.reply);
            fs.unlink(temppath, (err) => {});
            return;
        }
        
        //Simulations end here
        if (readOnly) {
            fs.unlink(temppath, (err) => {});
            return;
        }
        
        //Start index entry, disk space usage update and rename
        this._usage += fs.statSync(temppath).size;
        
        let entry = (mp.regrab ? mp.regrab : {});
        
        if (mp.info.replace) {
            //Replacement
            entry = this._index[mp.info.replace];
            if (!entry.replaced) entry.replaced = [];
            entry.replaced.push([mp.info.replace, mp.author, now]);
            await this.removeByHash(mp.info.replace, true);
        }
        
        entry.hash = hash;
        entry.format = mp.info.format;

        let tweak = mp.info.tweak || 0;
        tweak = Math.min(tweak, this.param("loudCustomTweak"));
        tweak = Math.max(tweak, this.param("loudCustomTweak") * -1);
        entry.tweak = tweak;
        
        await promisify(fs.rename)(temppath, realpath);

        let { mean_volume } = await analyzeVolume(realpath);
        entry.loudness = mean_volume;
        
        //If this was a regrab, recover previous metadata, otherwise...
        if (!mp.regrab) {
            if (typeof info == "object") {
                let kw = entry.keywords;
                
                for (let key in info) {
                    if (info[key] || entry[key] === undefined) {
                        entry[key] = info[key];
                    }
                }
                
                //Recover keywords if entry already contained them (from mp.info.replace)
                if (kw && info.keywords) {
                    for (let keyword of kw) {
                        if (entry.keywords.findIndex(x => x.toLowerCase() == keyword.toLowerCase()) < 0) {
                            entry.keywords.push(keyword);
                        }
                    }
                }
            }
            
            entry.seen = [now];
            entry.sharedBy = [mp.author];
            if (mp.interval) entry.length = mp.interval[1] - mp.interval[0];
            entry.sourcePartial = mp.interval;
            entry.name = mp.info.title || (entry.name ?? info.name);
            entry.author = mp.info.artist || (entry.author ?? (info.author || ""));
            entry.album = mp.info.album || (entry.album ?? (info.album || ""));
            entry.track = mp.info.track || (entry.track ?? (info.track || null));
            if (!entry.keywords) entry.keywords = [];
        }

        //Save indices and update stats
        
        this._index[hash] = entry;
        this._index.save();
        
        if (!this._indexSourceTypeAndId[entry.sourceType]) {
            this._indexSourceTypeAndId[entry.sourceType] = {};
        }
        this._indexSourceTypeAndId[entry.sourceType][entry.sourceSpecificId] = this._index[hash];

        if (entry.album && entry.track) {
            let albumCompacted = entry.album.replace(/ /g, "").toLowerCase();
            if (!this._indexAlbumAndTrack[albumCompacted]) {
                this._indexAlbumAndTrack[albumCompacted] = {};
            }
            this._indexAlbumAndTrack[albumCompacted][entry.track] = this._index[hash];
        }
        
        if (!mp.regrab) {
            let shares = this.getUserStat(mp.author, "shares");
            await this.setUserStat(mp.author, "shareavglength", (this.getUserStat(mp.author, "shareavglength") * shares + entry.length) / (shares + 1));
            await this.setUserStat(mp.author, "shareminlength", Math.min(this.getUserStat(mp.author, "shareminlength") || 0, entry.length));
            await this.setUserStat(mp.author, "sharemaxlength", Math.max(this.getUserStat(mp.author, "sharemaxlength") || Number.MAX_VALUE, entry.length));
            await this.incrUserStat(mp.author, "shares");
            
            this._sessionGrabs.unshift([hash, now]);
        }
        
        this.log('  Successfully grabbed from ' + entry.sourceType + ': ' + originalname + '  (as `#' + hash + '`)');
        if (callbacks.accepted) callbacks.accepted(messageObj, mp.authorName, mp.reply, hash);
        
        if (!mp.regrab) {
            this.emit("newSong", messageObj, mp.authorName, mp.reply, hash);
        }

    }
    
    
    //Download path
    
    calculateDownloadPathUsage() {
        let total = 0;
        for (let file of fs.readdirSync(this.param('downloadPath'))) {
            if (!file.match(/\.(mp3|flac|pcm)$/)) continue;
            total += fs.statSync(this.param('downloadPath') + '/' + file).size;
        }
        this._usage = total;
    }
    
    isDownloadPathFull() {
        if (!this.param('maxDiskUsage')) return false;
        return this._usage > this.param('maxDiskUsage');
    }
    
    
    //Other auxiliary methods

    extractHashes(text) {
        if (!text) return [];
        let results = [...text.matchAll(/#([0-9a-f]{32})/ig)].map(result => result[1]);
        if (!results) return [];
        return results;
    }
    
    /* Expand alternative syntaxes in 'hash' arguments. Returns:
        true - Ambiguous (parameter matches more than one indexed song)
        HASH - Parameter matches that song
        false - Requested offset goes beyond current session history
        null - Parameter matches nothing (song not found)
    */
    parseHashArg(hashoroffset, userid) {
        if (!hashoroffset) hashoroffset = "";
        if (typeof hashoroffset != "string") return null;
        
        hashoroffset = hashoroffset.trim();
        
        //Hash
        let ishash = hashoroffset.match(/^#([0-9a-f]{32})$/i);
        if (ishash) return ishash[1];
        
        //Offset (recently shared song)
        let isoffset = hashoroffset.match(/^-([0-2]?[0-9])?/);
        if (isoffset) {
            let offset = isoffset[1];
            if (offset == 0) return null;
            if (!offset) offset = 1;
            if (offset > this._sessionGrabs.length) {
                return false;
            }
            return this._sessionGrabs[offset - 1][0];
        }
        
        //Custom filters registered by other modules
        for (let item of this._parserFilters) {
            let mr = hashoroffset.match(item[0]);
            if (!mr) continue;
            return item[1](hashoroffset, mr, userid);
        }
        
        //Plain search string
        let searchResult = this.parseSearchInMixedParam(hashoroffset);
        if (searchResult === true) return true;
        if (searchResult !== null) return searchResult.hash;

        return null;
    }
    
    async removeByHash(hash, ismoderator, removerid) {
        if (!this._index[hash]) return false;
        fs.unlink(this.param('downloadPath') + '/' + hash + '.' + (this._index[hash].format || this.param('defaultFormat')), (err) => {});
        
        let info = this._index[hash];
        for (let sharer of info.sharedBy) {            
            let shares = this.getUserStat(sharer, "shares");
            await this.setUserStat(sharer, "shareavglength", (this.getUserStat(sharer, "shareavglength") * shares - info.length) / (shares - 1));
            await this.incrUserStat(sharer, "shares", -1);
        }
        
        let completed = await this.emit('removeSong', hash, ismoderator, removerid);
        if (!completed) return false;
        
        info = this._index[hash];
        if (this._indexSourceTypeAndId[info.sourceType] && this._indexSourceTypeAndId[info.sourceType][info.sourceSpecificId]) {
            delete this._indexSourceTypeAndId[info.sourceType][info.sourceSpecificId];
        }

        if (info.album && info.track) {
            let albumCompacted = info.album.replace(/ /g, "").toLowerCase();
            if (this._indexAlbumAndTrack[albumCompacted] && this._indexAlbumAndTrack[albumCompacted][info.track]) {
                delete this._indexAlbumAndTrack[albumCompacted][info.track];
            }
        }
        
        delete this._index[hash];
        this._index.save();
        return true;
    }
    
    
    dequeueAndScan() {
        if (!this._scanQueue) return;
        if (this._downloads >= this.param('maxSimDownloads')) return;
        let item = this._scanQueue.shift();
        if (!item) return;
        if (item[2] && this._cache[item[2]] && (this._cache[item[2]].ongoing || this._cache[item[2]].ongoinginfo)) {
            this._scanQueue.unshift(item);
            return;
        }
        item[1]();
    }
    
    
    filterSongsBySearchString(searchstr) {
        let filters = searchstr.split(' & ');
        if (!filters.length) return [];
        
        let results = [];
        for (let hash in this._index) results.push(this._index[hash]);

        for (let filter of filters) {
            let regexfilter = new RegExp(filter.replace(/[-\/\\^$*+?.()|[\]{}]/gu, '\\$&').replace(' ', '.*'), 'i');
            results = results.filter(
                (info) => info.sharedBy.find((e, i, a) => e.match(regexfilter)) || info.source.match(regexfilter) || info.name.match(regexfilter) || info.author.match(regexfilter) || info.album && info.album.match(regexfilter) || info.keywords.find((e, i, a) => e.match(regexfilter))
            );
        }
        
        return results;
    }
    
    parseSearchInMixedParam(str) {
        let extract = str.match(/^(\??)(.+)$/);
        if (!extract) return null;
        let songs = this.filterSongsBySearchString(extract[2]);
        if (songs.length > 1) {
            if (extract[1]) {
                return songs[Math.floor(random.fraction() * songs.length)];
            } else {
                return true;
            }
        } else if (songs.length == 1) {
            return songs[0];
        }
        return null;
    }
    
    
    parseInterval(intervalstring) {  //"00:00:00,23:59:59" => [minseconds, maxseconds]
        if (!intervalstring) return [0, 0];
        let parts = intervalstring.split(',');
        let min = parts[0] || "0";
        let max = parts[1] || String(Number.MAX_SAFE_INTEGER);
        let minparts = min.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        let actualmin = (minparts ? parseInt(minparts[5]) + (parseInt(minparts[4])||0) * 60 + (parseInt(minparts[3])||0) * 3600 : 0);
        let maxparts = max.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        let actualmax = (maxparts ? parseInt(maxparts[5]) + (parseInt(maxparts[4])||0) * 60 + (parseInt(maxparts[3])||0) * 3600 : Number.MAX_SAFE_INTEGER);
        if (actualmin > Number.MAX_SAFE_INTEGER) actualmin = Number.MAX_SAFE_INTEGER;
        if (actualmax < actualmin) actualmax = actualmin;
        return [actualmin, actualmax];
    }
    
    
    async reformat(song, format) {
        if (!format || AUDIO_FORMATS.indexOf(format) < 0) format = this.param('defaultFormat');
        if (format == song.format) return song;
    
        let oldpath = this.param('downloadPath') + '/' + song.hash + '.' + (song.format || 'mp3');
        let temppath = this.param('downloadPath') + '/' + 'ref_' + (this._preparing++) + '.' + format;
        
        return new Promise((resolve, reject) => {

            let ffmpeg = new FFmpeg(oldpath);
            let stream = fs.createWriteStream(temppath);
            
            if (format == 'pcm') {
                ffmpeg.format('s16le').audioBitrate('48k').audioChannels(2);
            } else if (format == 'flac') {
                ffmpeg.format('flac');
            } else {
                ffmpeg.format('mp3');
            }
            let audio = ffmpeg.pipe(stream);
            
            ffmpeg.on('error', (error) => {
                reject(error);
                audio.destroy();
            });
            
            stream.on('error', (error) => {
                reject(error);
                audio.destroy();
            });
            
            stream.on('finish', async () => {
                let data = await promisify(fs.readFile)(temppath);
                if (!data) throw "Converted file is empty.";
                    
                let hash = crypto.createHash('md5').update(data).digest('hex');
                let newpath = this.param('downloadPath') + '/' + hash + '.' + format;

                await promisify(fs.rename)(temppath, newpath);
                this._usage += fs.statSync(newpath).size;

                this._usage -= fs.statSync(oldpath).size;
                await promisify(fs.unlink)(oldpath);
                
                let newsong = Object.assign({}, song);
                newsong.format = format;
                newsong.hash = hash;
                resolve(newsong);
            });
            
        });
    }
    
    
    
    // # API #
    
    
    randomSong() {
        let allhashes = Object.keys(this._index);
        if (!allhashes.length) return null;
        let hash = allhashes[Math.floor(random.fraction() * allhashes.length)];
        return this._index[hash];
    }
    
    
    latestSong() {
        if (!this._sessionGrabs.length) return null;
        return this._index[this._sessionGrabs[0][0]];
    }
    
    
    everySong() {
        return Object.keys(this._index);
    }
    
    
    findSong(searchstr, extended) {
        let songs = this.filterSongsBySearchString(searchstr);
        if (songs.length) {
            if (extended) {
                return [songs[0], songs.length];
            } else {
                return songs[0];
            }
        }
        return null;
    }
    
    
    hashSong(hash) {
        return this._index[hash];
    }
    
    songPathByHash(hash) {
        for (let ext of AUDIO_FORMATS) {
            let result = this.param('downloadPath') + '/' + hash + '.' + ext;
            if (fs.existsSync(result)) return result;
        }
        return null;
    }
    
    
    bestSongForHashArg(mixed, userid) {
        return this.parseHashArg(mixed, userid);
    }

    
    getSongMeta(hash, field) {
        if (!this._index[hash]) return null;
        return this._index[hash][field];
    }
    
    setSongMeta(hash, field, value) {
        if (!this._index[hash]) return false;
        this._index[hash][field] = value;
        this._index.save();
        return true;
    }


    addSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        let ret = false;
        if (this._index[hash].keywords.indexOf(keyword) < 0) {
            this._index[hash].keywords.push(keyword);
            this._index.save();
            ret = true;
        }
        return ret;
    }
    
    removeSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        let ind = this._index[hash].keywords.indexOf(keyword);
        let ret = false;
        if (ind > -1) {
            this._index[hash].keywords.splice(ind, 1);
            this._index.save();
            ret = true;
        }
        return ret;
    }
    
    
    allSongWords(hash) {
        if (!this._index[hash]) return false;
        let minimalize = (str) => str.toLowerCase().replace(/\([^)]*\)/g, "").trim().replace(/ +/g, " ");
        let result = {};
        if (this._index[hash].name) result[minimalize(this._index[hash].name)] = true;
        if (this._index[hash].author) result[minimalize(this._index[hash].author)] = true;
        if (this._index[hash].album) result[minimalize(this._index[hash].album)] = true;
        for (let keyword of this._index[hash].keywords) {
            result[minimalize(keyword)] = true;
        }
        return Object.keys(result);
    }
    
    
    getUserStat(userid, field) {
        if (!this._stats.users[userid]) return null;
        return this._stats.users[userid][field];
    }
    
    async setUserStat(userid, field, value, nosave) {
        if (!this._stats.users[userid]) {
            let guildmember = this.denv.server.members.cache.get(userid);
            this._stats.users[userid] = {
                displayname: await this.denv.idToDisplayName(userid),
                avatar: (guildmember ? guildmember.user.displayAvatarURL({size: 512}) : null)
            };
        }
        this._stats.users[userid][field] = value;
        if (!nosave) this.saveStats();
        return true;
    }
    
    async incrUserStat(userid, field, amount, nosave) {
        let value = this.getUserStat(userid, field) || 0;
        amount = amount || 1;
        value += amount;
        await this.setUserStat(userid, field, value, nosave);
    }
    
    cleanUserStats(field) {
        if (!this._stats.users) return;
        for (let userid in this._stats.users) {
            if (this._stats.users[userid][field] !== undefined) {
                delete this._stats.users[userid][field];
            }
        }
        this.saveStats();
    }

    setAdditionalStats(field, value) {
        this._stats[field] = value;
        this.saveStats();
    }
    
    
    //Callback signature: messageObj, messageAuthor, reply, hash
    registerOnNewSong(func) {
        this.log('Registering new song callback.');
        this._apiCbNewSong.push(func);
    }
    
    
    //Callback signature: messageObj, messageAuthor, reply, hash
    registerOnGrabscanExists(func) {
        this.log('Registering song found on scan callback.');
        this._apiCbGrabscanExists.push(func);
    }
    
    
    //Callback signature: hash, ismoderator, removerid (only hash is guaranteed to be defined)
    registerOnRemoveSong(func) {
        this.log('Registering remove song callback.');
        this._apiCbRemoveSong.push(func);
    }
    
    
    //Filter callback signature: hashoroffset, matchresult
    registerParserFilter(label, regex, func, description) {
        this.log('Registering parser filter ' + label + '.');
        this._hashhelp.push([label, description]);
        this._parserFilters.push([regex, func]);
    }
    
    
    //Add stuff to the scan queue

    queueScanMessage(messageObj, callbacks, readOnly) {
        this._scanQueue.push(["Scan message", function() {
            this.grabInMessage(messageObj, callbacks, readOnly || false);
        }.bind(this)]);
    }
    
    queueRegrab(song, format, callbacks, readOnly) {
        this._scanQueue.push(["Regrab", function() {
            this.reGrab(song, format || this.param('defaultFormat'), callbacks, readOnly || false);
        }.bind(this)]);
    }
    
    queueReformat(song, format, callbacks) {
        this._scanQueue.push(["Reformat", function() {
            this._downloads += 1;
            this.log('Reformatting ' + song.hash);
            this.reformat(song, format)
                .then((newsong) => {
                    this._downloads -= 1;
                    if (this._index[song.hash]) delete this._index[song.hash];
                    this._index[newsong.hash] = newsong;
                    this._index.save();
                    if (callbacks.success) callbacks.success(newsong);
                })
                .catch((err) => {
                    this._downloads -= 1;
                    if (callbacks.error) callbacks.error(song, err);
                });
        }.bind(this)]);
    }

    queueAnalyze(song, callbacks) {
        this._scanQueue.push(["Analyze", function() {
            this.log('Analyzing ' + song.hash);
            analyzeVolume(this.songPathByHash(song.hash))
                .then(({mean_volume}) => {
                    this._index[song.hash].loudness = mean_volume;
                    this._index.save();
                    if (callbacks.success) callbacks.success(song, mean_volume);
                })
                .catch((err) => {
                    if (callbacks.error) callbacks.error(song, err);
                });
        }.bind(this)]);
    }
    
}
