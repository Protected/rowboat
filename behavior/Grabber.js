/* Module: Grabber -- Downloads song files referenced in a Discord channel and maintains a dynamic index w/ API. */

const Module = require('../Module.js');
const fs = require('fs');
const crypto = require('crypto');
const cp = require('child_process');
const { promisify } = require('util');
const { Readable } = require('stream');

const ytdl = require('ytdl-core');
const FFmpeg = require('fluent-ffmpeg');
const normalize = require('ffmpeg-normalize');
const moment = require('moment');
const random = require('meteor-random');
const { stream } = require('winston');

const PERM_ADMIN = 'administrator';
const PERM_MODERATOR = 'moderator';
const INDEXFILE = 'index.json';
const STATSFILE = 'stats.json';

const GET_FIELDS = ['name', 'author', 'album', 'track', 'length', 'source', 'sourceSpecificId', 'sourceLoudness', 'sharedBy', 'hash'];
const SET_FIELDS = ['name', 'author', 'album', 'track'];
const NUMBER_FIELDS = ['track'];

const AUDIO_FORMATS = ['pcm', 'flac', 'mp3'];

const YOUTUBEDLURL = 'https://youtube-dl.org/downloads/latest/youtube-dl';


class ModGrabber extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channels'              //List of IDs of the Discord channels to be used
    ]; }
    
    get optionalParams() { return [
        'downloadPath',         //Path to store the downloaded files (index.json will also be created)
        'minDuration',          //Minimum duration of the audio file (seconds)
        'maxDuration',          //Maximum duration of the audio file (seconds)
        'maxDiskUsage',         //Amount of disk space grabber is allowed to use in the downloadPath excluding index (bytes)
        'maxSimDownloads',      //Maximum simultaneous actions (downloads or fixes)
        'scanDelay',            //Delay between attempts to process messages (pending messages are queued) (ms)
        'selfDeleteExpiration', //Deadline for sharer to delete a song (counted from song's first share) (s)
        'permissionsDeleteAll', //List of sufficient permissions for deleting songs not shared by the user
        'permissionsReplace',   //List of sufficient permissions for replacing previously indexed songs
        'defaultFormat',        //Default storage format
        'allowPcm',             //Allow PCM storage
        'allowFlac',            //Allow FLAC storage
        'defaultBehavior',      //How to treat messages by default. One of: 'ignore', 'quiet', 'feedback'
        'tagIgnore',            //Tag message to be ignored (regex)
        'tagQuiet',             //Tag message to be quietly processed (regex)
        'tagFeedback',          //Tag message to be processed and provide feedback (regex)
        'useYoutubedl',         //Download and use youtube-dl features. Currently: Chapters
        'normalization',        //Normalize downloaded files. One of: false, true/'ebuR128', 'rms'
        'normalTarget',         //Normalization target in LUFS or dB depending on the algorithm chosen above
        'normalCustomTweak'     //Allowable customization interval (added to target) for normalization
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Grabber', name);
        
        this._params['downloadPath'] = "songs";
        this._params['minDuration'] = 90;
        this._params['maxDuration'] = 1500;
        this._params['maxDiskUsage'] = null;
        this._params['maxSimDownloads'] = 2;
        this._params['scanDelay'] = 200;
        
        this._params['selfDeleteExpiration'] = 604800;  //7 days
        this._params['permissionsDeleteAll'] = [PERM_MODERATOR, PERM_ADMIN];
        this._params['permissionsReplace'] = [PERM_MODERATOR, PERM_ADMIN];

        this._params['defaultFormat'] = 'mp3';
        this._params['allowPcm'] = false;
        this._params['allowFlac'] = false;

        this._params['defaultBehavior'] = 'feedback';
        this._params['tagIgnore'] = '^XX';
        this._params['tagQuiet'] = '^$$';
        this._params['tagFeedback'] = '^!!';
        
        this._params['useYoutubedl'] = false;
        this._params['normalization'] = 'rms';
        this._params['normalTarget'] = -20;
        this._params['normalCustomTweak'] = 4;
        
        this._preparing = 0;  //Used for generating temporary filenames
        
        this._index = {};  //Main index (hash => info)
        this._indexSourceTypeAndId = {};  //{sourceType: {sourceId: ..., ...}}
        this._indexAlbumAndTrack = {};  //{albumCompacted: {track: ..., ...}}
        this._stats = null;  //{users: {userid: {displayname, shares, shareavglength, ...}, ...}}
        
        this._usage = 0;  //Cache disk usage (by mp3s only)
        this._sessionGrabs = [];  //History of hashes grabbed in this session
        this._parserFilters = [];  //[[regex, callback(string)], ...] to apply to hashoroffset arguments (see API)
        
        this._scanQueue = [];  //Rate-limit song downloads and other heavy actions. Each item is: ["description", anonymous function that performs the action, cacheurl]
                                //  where cacheurl is an optional cache key used to delay dequeueing while cache is under construction.
        this._scanTimer = null;
        this._downloads = 0;
        
        this._apiCbNewSong = [];  //List of callbacks called when new songs are added. Return true to stop processing.
        this._apiCbGrabscanExists = [];  //List of callbacks called when existing songs are detected by a grabscan call. Return true to stop processing.
        this._apiCbRemoveSong = [];  //List of callbacks called when songs are removed.

        this._cache = {};  //{url: {ongoinginfo: boolean, info, ongoing: boolean, data}} Temporary cache
        
        this._path = __dirname;
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        //Download youtube-dl

        this._path = opt.rootpath;

        if (this.param('useYoutubedl')) {
            if (!fs.existsSync(this.youtubedlPath)) {
                let url = YOUTUBEDLURL;
                if (process.platform == 'win32') url += '.exe';
                this.downloadget(url, this.youtubedlPath)
                    .then(() => {
                        this.log('Downloaded youtube-dl into current directory.');
                        if (process.platform != 'win32') {
                            cp.execSync('chmod u+x ' + this.youtubedlPath);
                        }
                    })
                    .catch((e) => {
                        this.log('warn', 'Failed to download youtube-dl: ' + e);
                    });
            } else {
                this.log('youtube-dl found in current directory.');
            }
        }

        //Load index
        
        this._index = this.loadData(this.param('downloadPath') + '/' + INDEXFILE, {}, {abspath: true, pretty: true, quiet: true});
        if (this._index === false) return false;
        
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
        
        var self = this;
        this._scanTimer = setInterval(() => {
            self.dequeueAndScan.apply(self, null)
        }, this.param('scanDelay'));

      
        //Register callbacks
        
        if (!opt.envs[this.param('env')]) {
            this.log('error', "Environment not found.");
            return false;
        }
        
        opt.envs[this.param('env')].on('message', this.onMessage, this);
        opt.envs[this.param('env')].on('connected', () => { this.loadStats(); }, this);
        
        
        this.mod('Commands').registerRootDetails(this, 'grab', {description: "Manipulate the collection of songs from a Discord channel."});
        
        this.mod('Commands').registerRootDetails(this, 'song', {
            description: "Interact with the song library and index.",
            details: [
                "The following expansions are natively provided for hash arguments:",
                "  -NUMBER : References latest learned song or a recently learned song.",
                "  (String) : Performs a search by string and returns the hash of the single result, or an error if there are 0 or more than 1 results.",
                "  (?String) : Performs a search by string and returns the hash of a random result."
            ]
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab scan', {
            description: 'Scans channel history until INTERVAL days ago and grabs any song files.',
            args: ['channelid', 'interval'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
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
                    let messagesarr = messages.array();
                    if (messagesarr.length < 100) endNow = true;
                    for (let message of messagesarr) {
                        if (message.createdTimestamp <= cutoff) endNow = true;
                        this.queueScanMessage(message, {
                            exists: (messageObj, messageAuthor, reply, hash) => {
                                this.processOnGrabscanExists(messageObj, messageAuthor, reply, hash);
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
        
        
        this.mod('Commands').registerCommand(this, 'grab regrab', {
            description: 'Fix the library by attempting to redownload songs from source (if not missing).',
            args: ['hashoroffset', 'format', 'onlyreformat'],
            minArgs: 0,
            permissions: [PERM_ADMIN]
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
        
        
        this.mod('Commands').registerCommand(this, 'grab undo', {
            description: 'Undo a single recent grab from this session.',
            args: ['offset'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
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

                let candeleteall = this.mod('Users').testPermissions(this.param('env'), userid, channelid, this.param('permissionsDeleteAll'));
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
                        if (!this.removeByHash(info.hash, candeleteall, userid)) {
                            ep.reply('Hash not found or not removable.');
                            return true;
                        }
                    } else {
                        ep.reply('You can\'t delete this song; it was shared too long ago.');
                        return true;
                    }
                }

                ep.reply('Ok.');
            } else {
                ep.reply('Historic hash not found in index! I will just remove it from the history.');
            }
            
            this._sessionGrabs.splice(-args.offset - 1, 1);
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab delete', {
            description: 'Delete an indexed song by hash.',
            args: ['hashoroffset']
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

            let candeleteall = this.mod('Users').testPermissions(this.param('env'), userid, channelid, this.param('permissionsDeleteAll'));

            if (!candeleteall) {
                let info = this._index[hash];
                if (info.sharedBy.length > 1) {
                    info.sharedBy = info.sharedBy.filter((shareid) => shareid != userid);
                    ep.reply('Ok.');
                    return true;
                } else if (info.sharedBy[0] != userid) {
                    ep.reply("You can only delete your own songs.");
                    return true;
                } else if (moment().unix() - info.seen[0] < this.param('selfDeleteExpiration')) {
                    ep.reply('You can\'t delete this song; it was shared too long ago.');
                    return true;
                }
            }
                    
            if (this.removeByHash(hash, candeleteall, userid)) {
                this._sessionGrabs = this._sessionGrabs.filter((item) => item[0] != hash);
                ep.reply('Ok.');
            } else {
                ep.reply('Hash not found or not removable.');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab latest', {
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


        this.mod('Commands').registerCommand(this, 'grab tasks', {
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
        
        
        this.mod('Commands').registerCommand(this, 'grab fixloudness', {
            description: 'Adjust the loudness of a song to match the instance target.',
            details: [
                'This operation is lossy if the song is cached in a lossy format.'
            ],
            args: ['hashoroffset'],
            minArgs: 0,
            permissions: [PERM_ADMIN]
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
            
                this.queueFixLoudness(this._index[hash], {
                    success: (newsong) => ep.reply(newsong.hash + ": Loudness fixed from " + hash + "."),
                    error: (oldsong, err) => ep.reply(oldsong.hash + ": Failed loudness fix: " + err)
                });

                ep.reply("Loudness fix requested.");
                return true;
            }
        
            ep.reply("Sit tight, this may take a long time...");
        
            let i = 0;
        
            for (let hash in this._index) {
                this.queueFixLoudness(this._index[hash], {
                    success: (newsong) => {
                        i += 1;
                        if (!(i % 100)) ep.reply(i + " fixed so far.");
                    },
                    error: (oldsong, err) => ep.reply(oldsong.hash + ": Failed loudness fix: " + err)
                });
            }
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab reformat', {
            description: 'Convert a cached song to a different format.',
            details: [
                'This operation is lossy if the song is converted to a lossy format.'
            ],
            args: ['hashoroffset', 'format'],
            permissions: [PERM_ADMIN]
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
                success: (newsong) => ep.reply(newsong.hash + ": Reformat from " + hash + "."),
                error: (oldsong, err) => ep.reply(oldsong.hash + ": Failed reformat: " + err)
            });

            ep.reply("Reformat requested.");
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'song find', {
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
        
        
        this.mod('Commands').registerCommand(this, 'song set', {
            description: 'Change metadata of an indexed song.',
            details: [
                "Allowed fields: " + SET_FIELDS.join(', ')
            ],
            args: ['hashoroffset', 'field', 'value', true],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
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

            //-----Logic for indexByAlbumAndTrack
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
            
            ep.reply("Ok.");
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'song get', {
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


        this.mod('Commands').registerCommand(this, 'song album', {
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
        
        
        this.mod('Commands').registerCommand(this, 'song kw', {
            description: 'List keywords associated with an indexed song.',
            args: ['hashoroffset'],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
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
        
        
        this.mod('Commands').registerCommand(this, 'song kw add', {
            description: 'Associate a new keyword with an indexed song.',
            args: ['hashoroffset', 'keyword', true],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
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
                ep.reply("Ok.");
            } else {
                ep.reply("Already existed.");
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'song kw remove', {
            description: 'Remove a keyword from an indexed song.',
            args: ['hashoroffset', 'keyword', true],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
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
                ep.reply("Ok.");
            } else {
                ep.reply("Doesn't exist.");
            }
        
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    //Youtube-dl
    
    get youtubedlPath() {
        let path = this._path + '/youtube-dl';
        if (process.platform === 'win32') path += '.exe';
        return path;
    }
    
    async youtubedlChapters(url) {
        return new Promise((resolve, reject) => {
            let inst = cp.execFile(this.youtubedlPath, ['-j', url], {windowsHide: true}, (error, stdout, stderr) => {
                if (!inst.exitCode) {
                    let json = JSON.parse(stdout);
                    if (json && json.chapters) resolve(json.chapters);
                    else resolve([]);
                } else {
                    reject("Failed to retrieve chapters: " + stderr);
                }
            });
        });
    }
    
    youtubedlDownload(url, localpath) {
        return cp.execFile(this.youtubedlPath, ['-q', '-o', localpath, url]);
    }
    
    
    //Stats file manipulation
    
    loadStats() {
        if (this._stats) return true;
        
        //This file is rebuilt every time we start the module.
        
        this._stats = {users: {}};

        let shareavglength = {};
        let sharemaxlength = {};
        let shareminlength = {};
        
        for (let hash in this._index) {
            let info = this._index[hash];
            for (let sharer of info.sharedBy) {
                this.incrUserStat(sharer, "shares", 1, true);
                if (!shareavglength[sharer]) shareavglength[sharer] = 0;
                shareavglength[sharer] += info.length;
                if (!sharemaxlength[sharer]) sharemaxlength[sharer] = info.length; else sharemaxlength[sharer] = Math.max(sharemaxlength[sharer], info.length);
                if (!shareminlength[sharer]) shareminlength[sharer] = info.length; else shareminlength[sharer] = Math.min(shareminlength[sharer], info.length);
            }
        }
        
        for (let sharer in shareavglength) {
            this.setUserStat(sharer, "shareavglength", shareavglength[sharer] / this.getUserStat(sharer, "shares"), true);
            this.setUserStat(sharer, "shareminlength", shareminlength[sharer], true);
            this.setUserStat(sharer, "sharemaxlength", sharemaxlength[sharer], true);
        }
        
        this.saveStats();
        
        return true;
    }
    
    saveStats() {
        this.saveData(this.param('downloadPath') + '/' + STATSFILE, this._stats, {abspath: true, pretty: true, quiet: true});
    }
    
    
    //Message processing
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (env.name != this.param('env')) return false;
        if (this.param('channels').indexOf(channelid) < 0) return false;
        this.queueScanMessage(rawobj, {
            accepted: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply("Got it, " + messageAuthor + " (" + hash + ").");
            },
            exists: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply(messageAuthor + ", the song was already known (" + hash + ").");
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
            },
            errorNormalizedCollision: (messageObj, messageAuthor, reply) => {
                if (reply) reply(messageAuthor + ", the hash of the normalized version of the song collided with an existing hash.");
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
        let getformat = message.match(/\{format(=|:) ?(mp3|flac|pcm)\}/iu);
        if (getformat) {
            if (getformat[2] == 'mp3') format = 'mp3';
            if (this.param('allowFlac') && getformat[2] == 'flac') format = 'flac';
            if (this.param('allowPcm') && getformat[2] == 'pcm') format = 'pcm';
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
        if (from == 'youtube' && this.param('useYoutubedl')) {
            try {
                chapters = await this.youtubedlChapters(url);
            } catch (e) {
                this.log('warn', 'Chapter extraction: ' + e);
            }
        }
    
        let messageInfo = this.extractMessageInfo(fragment, {authorid: messageObj.author.id, chapters: chapters});
        let tenv = this.env(this.param('env'));

        if (messageInfo.replace) {
            if (!this.mod('Users').testPermissions(this.param('env'), messageObj.author.id, messageObj.channel.id, this.param('permissionsReplace'))) {
                messageInfo.replace = false;
            }
        }
        
        return {
            author: messageObj.author.id,
            authorName: tenv.idToDisplayName(messageObj.author.id),
            info: messageInfo,
            interval: messageInfo.interval,
            reply: (messageInfo.warnauthor ? (out) => tenv.msg(messageObj.channel.id, out) : null),
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
                        cmp.info.interval = [chapter.start_time, chapter.end_time]; //TODO
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
        if (single && messageObj.attachments && messageObj.attachments.array().length) {
            for (let ma of messageObj.attachments.array()) {
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
        
        if (this.param("useYoutubedl")) {
            //Bandcamp
            let bcurl = fragment.match(/(?:https?:\/\/|\/\/)?([a-z0-9-]+)\.bandcamp\.com\/track\/([\w_-]+)(?![\w_-])/);
            if (bcurl) {
                let mp = await this.obtainMessageParams(messageObj, fragment);
                this._scanQueue.push(["Grab using youtube-dl", function() {
                    this.grabFromYoutubedl(mp, bcurl[0], 'bandcamp', bcurl[1] + '__' + bcurl[2], messageObj, callbacks, readOnly)
                        .catch((e) => this.log('warn', 'Grab from Bandcamp: ' + e));
                }.bind(this)]);
            }
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
        } else if (info.sourceType == 'bandcamp') {
            this.grabFromYoutubedl(info.source, info.sourceType, info.sourceSpecificId, info, callbacks, readOnly)
                .catch((e) => this.log('warn', 'Regrab from Youtube-dl: ' + e));
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

        //Obtain metadata from youtube
        this.youtubeInfo(url)
            .then((info) => {
            
                let length = info.length_seconds || info.duration || info.videoDetails.lengthSeconds || info.player_response.videoDetails.lengthSeconds || 0;
                
                if (mp.interval && mp.interval[1] > length) {
                    mp.interval[1] = length;
                }
                
                if (!mp.interval && length < this.param('minDuration') || mp.interval && mp.interval[1] - mp.interval[0] < this.param('minDuration')
                        || length > this.param('maxDuration') && (!mp.interval || mp.interval[1] - mp.interval[0] > this.param('maxDuration'))) {
                    if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                    return;
                }
                        
                if (!mp.regrab && this._indexSourceTypeAndId['youtube'] && this._indexSourceTypeAndId['youtube'][info.video_id]
                        && !this._indexSourceTypeAndId['youtube'][info.video_id].sourcePartial && !mp.interval) {
                    if (callbacks.exists) callbacks.exists(messageObj, mp.authorName, mp.reply, this._indexSourceTypeAndId['youtube'][info.video_id].hash);
                    return;
                }
                
                let keywords = [];
                if (info.player_response && info.player_response.videoDetails && typeof info.player_response.videoDetails.keywords == "object") {
                    for (let keyword of info.player_response.videoDetails.keywords) {
                        keywords.push(keyword);
                    }
                }
                for (let dkeyword of mp.info.keywords) {
                    keywords.push(dkeyword);
                }
                
                let loudness = null;
                if (info.player_response && info.player_response.playerConfig && typeof info.player_response.playerConfig.audioConfig == "object") {
                    loudness = parseFloat(info.player_response.playerConfig.audioConfig.perceptualLoudnessDb);
                }
                
                this.log('Grabbing from youtube: ' + url);
                this._downloads += 1;
            
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
                        sourceSpecificId: info.video_id || info.videoDetails.video_id || info.videoDetails.videoId,
                        sourceLoudness: loudness,
                        name: info.title || info.videoDetails.title,
                        author: '',
                        album: '',
                        keywords: keywords
                    }, messageObj, callbacks, readOnly);
                });
                
            })
            .catch((err) => {
                this.log('warn', err);
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
    
    
    async grabFromYoutubedl(mp, url, sourceType, sourceSpecificId, messageObj, callbacks, readOnly) {
        if (mp.info.noextract) return;

        let filename = sourceSpecificId;
    
        this.log('Grabbing from ' + sourceType + ' using youtube-dl: ' + url + ' (' + sourceSpecificId + ')');
        this._downloads += 1;
        
        let prepnum = this._preparing++;
        
        //URL -> Hard drive
        
        let prepath = this.param('downloadPath') + '/' + 'dl_' + prepnum + '_a.tmp';
        let youtubedl = this.youtubedlDownload(url, prepath);

        youtubedl.on('error', (err) => {
            this.log('error', '[Youtube-dl, Process] ' + error);
            this._downloads -= 1;
        });
        
        youtubedl.on('exit', (code) => {
            if (code) {
                this.log('error', '[Youtube-dl, Exit code] ' + code);
                this._downloads -= 1;

                return;
            }
            
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
            this.log('  Already existed: ' + originalname + '  (as ' + hash + ')');
            if (!readOnly && !mp.regrab) {
                this._index[hash].seen.push(now);
                if (this._index[hash].sharedBy.indexOf(mp.author) < 0) {
                    this._index[hash].sharedBy.push(mp.author);
                    
                    let shares = this.getUserStat(mp.author, "shares");
                    this.setUserStat(mp.author, "shareavglength", (this.getUserStat(mp.author, "shareavglength") * shares + info.length) / (shares + 1));
                    this.setUserStat(mp.author, "shareminlength", Math.min(this.getUserStat(mp.author, "shareminlength") || 0, info.length));
                    this.setUserStat(mp.author, "sharemaxlength", Math.max(this.getUserStat(mp.author, "sharemaxlength") || Number.MAX_VALUE, info.length));
                    this.incrUserStat(mp.author, "shares");
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
            this.removeByHash(mp.info.replace, true);
        }
        
        entry.hash = hash;
        entry.format = mp.info.format;

        let tweak = mp.info.tweak || 0;
        tweak = Math.min(tweak, this.param("normalCustomTweak"));
        tweak = Math.max(tweak, this.param("normalCustomTweak") * -1);
        entry.tweak = tweak;
        
        await promisify(fs.rename)(temppath, realpath);
        
        //Normalize loudness. Returns a new index entry if successful.
        let normalized;
        if (this.param('normalization')) {
            try {
                normalized = await this.fixNormalization(entry);
            } catch (e) {
                this.log('  Normalized hash collision.');
                if (callbacks.errorNormalizedCollision) callbacks.errorNormalizedCollision(messageObj, mp.authorName, mp.reply);
                fs.unlink(realpath, (err) => {});
                return;
            }
        } 
        
        if (normalized && normalized.hash != entry.hash) {
            entry = normalized;
            hash = entry.hash;
        }

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
            entry.name = mp.info.title || info.name;
            entry.author = mp.info.artist || info.author || "";
            entry.album = mp.info.album || info.album || "";
            entry.track = mp.info.track || info.track || null;
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
            this.setUserStat(mp.author, "shareavglength", (this.getUserStat(mp.author, "shareavglength") * shares + entry.length) / (shares + 1));
            this.setUserStat(mp.author, "shareminlength", Math.min(this.getUserStat(mp.author, "shareminlength") || 0, entry.length));
            this.setUserStat(mp.author, "sharemaxlength", Math.max(this.getUserStat(mp.author, "sharemaxlength") || Number.MAX_VALUE, entry.length));
            this.incrUserStat(mp.author, "shares");
            
            this._sessionGrabs.unshift([hash, now]);
        }
        
        this.log('  Successfully grabbed from ' + entry.sourceType + ': ' + originalname + '  (as ' + hash + ')');
        if (callbacks.accepted) callbacks.accepted(messageObj, mp.authorName, mp.reply, hash);
        
        if (!mp.regrab) {
            this.processOnNewSong(messageObj, mp.authorName, mp.reply, hash);
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
    
    removeByHash(hash, ismoderator, removerid) {
        if (!this._index[hash]) return false;
        fs.unlink(this.param('downloadPath') + '/' + hash + '.' + (this._index[hash].format || this.param('defaultFormat')), (err) => {});
        
        let info = this._index[hash];
        for (let sharer of info.sharedBy) {            
            let shares = this.getUserStat(sharer, "shares");
            this.setUserStat(sharer, "shareavglength", (this.getUserStat(sharer, "shareavglength") * shares - info.length) / (shares - 1));
            this.incrUserStat(sharer, "shares", -1);
        }
        
        for (let cb of this._apiCbRemoveSong) {
            try {
                let r;
                if (typeof cb == "function") {
                    r = cb.apply(this, [hash, ismoderator, removerid]);
                } else {
                    r = cb[0].apply(cb[1], [hash, ismoderator, removerid]);
                }
                if (r) return false;
            } catch (exception) {
                this.log('error', 'Error in callback while removing ' + hash);
            }
        }
        
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
    
    
    processOnNewSong(messageObj, messageAuthor, reply, hash) {
        for (let cb of this._apiCbNewSong) {
            try {
                let r;
                if (typeof cb == "function") {
                    r = cb.apply(this, [messageObj, messageAuthor, reply, hash]);
                } else {
                    r = cb[0].apply(cb[1], [messageObj, messageAuthor, reply, hash]);
                }
                if (r) break;
            } catch (exception) {
                this.log('error', 'Error in callback after adding ' + hash);
            }
        }
    }
    
    
    processOnGrabscanExists(messageObj, messageAuthor, reply, hash) {
        for (let cb of this._apiCbGrabscanExists) {
            try {
                let r;
                if (typeof cb == "function") {
                    r = cb.apply(this, [messageObj, messageAuthor, reply, hash]);
                } else {
                    r = cb[0].apply(cb[1], [messageObj, messageAuthor, reply, hash]);
                }
                if (r) break;
            } catch (exception) {
                this.log('error', 'Error in callback after detecting existing ' + hash);
            }
        }
    }
    
    
    async fixNormalization(song) {
        
        let oldpath = this.param('downloadPath') + '/' + song.hash + '.' + (song.format || 'mp3');
        let temppath = this.param('downloadPath') + '/' + 'nor_' + (this._preparing++) + '.' + (song.format || this.param('defaultFormat'));

        let mode = this.param('normalization');
        if (!(['ebuR128', 'rms'].find(m => m == mode))) mode = 'ebuR128';
        
        let normalized = await normalize({
            input: oldpath,
            output: temppath,
            loudness: {
                normalization: mode,
                target: {
                    input_i: this.param('normalTarget') + song.tweak,
                    input_tp: 0
                }
            }
        });
        
        if (!normalized) {
            return song;
        }
        
        let newsong = Object.assign({}, song);
        
        newsong.normalized = {
            method: mode,
            from: normalized.info.measured,
            to: normalized.info.loudness
        };
        
        let data = await promisify(fs.readFile)(temppath);
        if (!data) throw "Normalized file is empty.";
            
        let hash = crypto.createHash('md5').update(data).digest('hex');
        let newpath = this.param('downloadPath') + '/' + hash + '.' + (newsong.format || this.param('defaultFormat'));

        if (fs.existsSync(newpath)) {
            promisify(fs.unlink)(temppath);
            throw "Normalized hash already exists.";
        }
        
        await promisify(fs.rename)(temppath, newpath);
        this._usage += fs.statSync(newpath).size;
        
        this._usage -= fs.statSync(oldpath).size;
        if (oldpath != newpath) {
            await promisify(fs.unlink)(oldpath);
        }
            
        newsong.hash = hash;
        
        return newsong;
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
    
    setUserStat(userid, field, value, nosave) {
        if (!this._stats.users[userid]) {
            let guildmember = this.env(this.param('env')).server.members.cache.get(userid);
            this._stats.users[userid] = {
                displayname: this.env(this.param('env')).idToDisplayName(userid),
                avatar: (guildmember ? guildmember.user.displayAvatarURL : null)
            };
        }
        this._stats.users[userid][field] = value;
        if (!nosave) this.saveStats();
        return true;
    }
    
    incrUserStat(userid, field, amount, nosave) {
        let value = this.getUserStat(userid, field) || 0;
        amount = amount || 1;
        value += amount;
        this.setUserStat(userid, field, value, nosave);
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
    registerOnNewSong(func, self) {
        this.log('Registering new song callback. Context: ' + self.constructor.name);
        if (!self) {
            this._apiCbNewSong.push(func);
        } else {
            this._apiCbNewSong.push([func, self]);
        }
    }
    
    
    //Callback signature: messageObj, messageAuthor, reply, hash
    registerOnGrabscanExists(func, self) {
        this.log('Registering song found on scan callback. Context: ' + self.constructor.name);
        if (!self) {
            this._apiCbGrabscanExists.push(func);
        } else {
            this._apiCbGrabscanExists.push([func, self]);
        }
    }
    
    
    //Callback signature: hash, ismoderator, removerid (only hash is guaranteed to be defined)
    registerOnRemoveSong(func, self) {
        this.log('Registering remove song callback. Context: ' + self.constructor.name);
        if (!self) {
            this._apiCbRemoveSong.push(func);
        } else {
            this._apiCbRemoveSong.push([func, self]);
        }
    }
    
    
    //Filter callback signature: hashoroffset, matchresult
    registerParserFilter(regex, func, self) {
        this.log('Registering parser filter. Context: ' + self.constructor.name);
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
    
    queueFixLoudness(song, callbacks) {
        this._scanQueue.push(["Fix loudness", function() {
            this._downloads += 1;
            this.log('Fixing loudness of ' + song.hash);
            this.fixNormalization(song)
                .then((newsong) => {
                    this._downloads -= 1;
                    if (song.hash == newsong.hash) return;
                    if (this._index[song.hash]) delete this._index[song.hash];
                    this._index[newsong.hash] = newsong;
                    this._index.save();
                    if (callbacks.success) callbacks.success(newsong);
                })
                .catch((err) => {
                    this._downloads -= 1;
                    if (callbacks.error) callbacks.error(song, err.error || err);
                });
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
    
}


module.exports = ModGrabber;
