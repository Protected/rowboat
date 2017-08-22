/* Module: Grabber -- Downloads song files referenced in a Discord channel and maintains a dynamic index w/ API. */

var Module = require('./Module.js');
var fs = require('fs');
var ytdl = require('ytdl-core');
var FFmpeg = require('fluent-ffmpeg');
var crypto = require('crypto');
var jsonfile = require('jsonfile');
var moment = require('moment');
var random = require('meteor-random');
var request = require('request');

const PERM_ADMIN = 'administrator';
const PERM_MODERATOR = 'moderator';
const INDEXFILE = 'index.json';

const GET_FIELDS = ['name', 'author', 'album', 'length', 'source', 'sourceSpecificId', 'sharedBy', 'hash'];
const SET_FIELDS = ['name', 'author', 'album'];


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
        'maxSimDownloads',      //Maximum simultaneous downloads
        'scanDelay',            //Delay between attempts to process messages (pending messages are queued) (ms)
        'permissionsReplace'    //List of sufficient permissions to replace previously indexed songs
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
        this._params['permissionsReplace'] = [PERM_MODERATOR, PERM_ADMIN];
        
        this._preparing = 0;  //Used for generating temporary filenames
        
        this._index = {};  //Main index (hash => info)
        this._indexSourceTypeAndId = {};  //{sourceType: {sourceId: ...}}
        
        this._usage = 0;  //Cache disk usage (by mp3s only)
        this._sessionGrabs = [];  //History of hashes grabbed in this session
        this._parserFilters = [];  //[[regex, callback(string)], ...] to apply to hashoroffset arguments (see API)
        
        this._scanQueue = [];  //Rate-limit song downloads. Each item is: [authorid, messageToScan]
        this._scanTimer = null;
        this._downloads = 0;
        
        this._apiCbNewSong = [];  //List of callbacks called when new songs are added. Return true to stop processing.
        this._apiCbGrabscanExists = [];  //List of callbacks called when existing songs are detected by a grabscan call. Return true to stop processing.
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //Load index
        
        if (!this.loadIndex()) return false;
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
        
        
        this.mod('Commands').registerRootDetails(this, 'grab', {description: "Manipulate the collection of songs from a Discord channel."});
        
        this.mod('Commands').registerRootDetails(this, 'song', {
            description: "Interact with the song library and index.",
            details: [
                "The following expansions are natively provided for hash arguments:",
                "  -NUMBER : References latest learned song or a recently learned song.",
                "  (String) : Performs a search by string and returns the hash of the single result, or an error if there are 0 or more than 1 results."
            ]
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab scan', {
            description: 'Scans channel history until INTERVAL days ago and grabs any song files.',
            args: ['channelid', 'interval'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var channel = env.server.channels.get(args.channelid);
            if (!channel) return false;
            
            var endNow = false;
            var cutoff = (moment().unix() - args.interval * 86400) * 1000;
            
            ep.reply("Scanning...");
            
            var scanning = null;
            var scanner = () => {
                channel.fetchMessages({
                    limit: 100,
                    before: scanning
                }).then((messages) => {
                    let messagesarr = messages.array();
                    if (messagesarr.length < 100) endNow = true;
                    for (let message of messagesarr) {
                        if (message.createdTimestamp <= cutoff) endNow = true;
                        this._scanQueue.push([message, {
                            exists: (messageObj, messageAuthor, reply, hash) => {
                                this.processOnGrabscanExists(messageObj, messageAuthor, reply, hash);
                            }
                        }]);
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
        
        
        this.mod('Commands').registerCommand(this, 'grab undo', {
            description: 'Undo a single recent grab from this session.',
            args: ['offset'],
            minArgs: 0,
            permissions: [PERM_ADMIN, PERM_MODERATOR]
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
            
            var info = this._index[this._sessionGrabs[-args.offset - 1][0]];
            if (info) {
                if (info.seen.length > 1) {
                    info.seen = info.seen.filter((ts) => ts != this._sessionGrabs[-args.offset - 1][1]);
                } else {
                    this.removeByHash(info.hash);
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
            args: ['hashoroffset'],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
                    
            var hash = this.parseHashArg(args.hashoroffset);
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
                    
            if (this.removeByHash(hash)) {
                this._sessionGrabs = this._sessionGrabs.filter((item) => item[0] != hash);
                ep.reply('Ok.');
            } else {
                ep.reply('Hash not found.');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grab latest', {
            description: 'Get the hash of a single recent song.',
            args: ['hashoroffset'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset, userid);
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
            
            ep.reply('`' + hash + '`');
            
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
                    ep.reply('`' + info.hash + ' ' + info.name + (info.author ? ' (' + info.author + ')' : '') + '`');
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
        
            var hash = this.parseHashArg(args.hashoroffset, userid);
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
            
            this._index[hash][args.field] = args.value.join(' ');
            
            this.saveIndex();
            
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
        
            var hash = this.parseHashArg(args.hashoroffset, userid);
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
        
        
        this.mod('Commands').registerCommand(this, 'song kw', {
            description: 'List keywords associated with an indexed song.',
            args: ['hashoroffset'],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset, userid);
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
        
            var hash = this.parseHashArg(args.hashoroffset, userid);
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
                this.saveIndex();
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
        
            var hash = this.parseHashArg(args.hashoroffset);
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
                this.saveIndex();
                ep.reply("Ok.");
            } else {
                ep.reply("Doesn't exist.");
            }
        
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    //Index file manipulation

    loadIndex() {
        var indexfile = this.param('downloadPath') + '/' + INDEXFILE;
     
        try {
            fs.accessSync(indexfile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(indexfile, {});
        }

        try {
            this._index = jsonfile.readFileSync(indexfile);
        } catch (e) {
            return false;
        }
        if (!this._index) this._index = {};
        
        for (let hash in this._index) {
            let info = this._index[hash];
            if (!this._indexSourceTypeAndId[info.sourceType]) {
                this._indexSourceTypeAndId[info.sourceType] = {};
            }
            this._indexSourceTypeAndId[info.sourceType][info.sourceSpecificId] = info;
        }
        
        return true;
    }

    saveIndex() {
        var indexfile = this.param('downloadPath') + '/' + INDEXFILE;
        
        jsonfile.writeFileSync(indexfile, this._index, {spaces: 4});
    }
    
    
    //Message processing
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (env.name != this.param('env')) return false;
        if (this.param('channels').indexOf(channelid) < 0) return false;
        this._scanQueue.push([rawobj, {
            accepted: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply("Got it, " + messageAuthor + ".");
            },
            exists: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply(messageAuthor + ", the song was already known (" + hash + ").");
            },
            errorDuration: (messageObj, messageAuthor, reply, label) => {
                if (reply) reply(messageAuthor + ", I only index songs with a duration between " + this.param('minDuration') + " and " + this.param('maxDuration') + " seconds.");
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
        }]);
    }
    
    
    extractMessageInfo(message) {
        var warnauthor = !!message.match(/^!!/);
    
        var dkeywords = message.match(/\[[A-Za-z0-9\u{3040}-\u{D7AF}\(\)' _-]+\]/gu);
        if (!dkeywords) dkeywords = [];
        dkeywords = dkeywords.map((item) => {
            let ikeyword = item.match(/^\[([^\]]+)\]$/u);
            if (!ikeyword) return null;
            return ikeyword[1];
        }).filter((item) => item);
        
        var title = message.match(/\{(title|name|song)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' !_-]+)\}/iu);
        if (title) title = title[3];
        var artist = message.match(/\{(author|artist|band)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' !_-]+)\}/iu);
        if (artist) artist = artist[3];
        var album = message.match(/\{(album)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' !_-]+)\}/iu);
        if (album) album = album[3];
        
        var replace = message.match(/\{replace(=|:) ?([0-9A-Fa-f]+)\}/iu);
        if (replace) replace = replace[2];
        
        var interval = null;
        if (title) {
            interval = message.match(/<(([0-9:]+)?(,[0-9:]+)?)>/);
            if (interval) interval = this.parseInterval(interval[1]);
        }
        
        return {
            warnauthor: warnauthor,
            keywords: dkeywords,
            title: title,
            artist: artist,
            album: album,
            replace: replace,
            interval: interval
        };
    }
    
    
    obtainMessageParams(messageObj) {
        let messageInfo = this.extractMessageInfo(messageObj.content, messageObj.author.id);
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
            reply: (messageInfo.warnauthor ? (out) => tenv.msg(messageObj.channel.id, out) : null)
        };
    }
    
    /* Callbacks:
        accepted(messageObj, messageAuthor, reply, hash) - The song has just been indexed as a result of this call (details can be retrieved from the index)
        exists(messageObj, messageAuthor, reply, hash) - A song already existed (details can be retrieved from the index)
        errorDuration(messageObj, messageAuthor, reply, label) - A song fails a duration check
        errorPermission(messageObj, messageAuthor, reply) - The song could not be collected because its metadata violated a permission check
        errorNotFound(messageObj, messageAuthor, reply) - The targeted song was not found in the index
        reply is either a function for replying to the environent (if the message is tagged for feedback) or null
    */
    grabInMessage(messageObj, callbacks, readOnly) {
        if (this.isDownloadPathFull() || !messageObj) return false;
        
        //Youtube
        let yturls = messageObj.content.match(/(?:https?:\/\/|\/\/)?(?:www\.|m\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})(?![\w-])/g);
        if (yturls) {
            for (let url of yturls) {
                this.grabFromYoutube(url, messageObj, callbacks, readOnly);
            }
        }
        
        //Attachment
        if (messageObj.attachments && messageObj.attachments.array().length) {
            for (let ma of messageObj.attachments.array()) {
                if (!ma.filename.match(/\.(mp3|ogg|flac|wav|wma|aac|m4a)$/) || ma.filesize < 20480) continue;
                this.grabFromAttachment(ma, messageObj, callbacks, readOnly);
            }
        }
        
        //Google Drive
        let gdurl = messageObj.content.match(/(?:https?:\/\/|\/\/)?(?:drive|docs)\.google\.com\/(?:(?:open|uc)\?id=|file\/d\/)([\w_]{28,})(?![\w_])/);
        if (gdurl) {
            gdurl = 'https://docs.google.com/uc?id=' + gdurl[1];
            this.grabFromURL(gdurl, 'gdrive', gdurl[1], messageObj, callbacks, readOnly);
        }
        
        //Dropbox
        let dburl = messageObj.content.match(/(?:https?:\/\/|\/\/)?(?:www\.)?dropbox\.com\/s\/([\w_]{15,})(?![\w_])/);
        if (dburl) {
            dburl = 'https://www.dropbox.com/s/' + dburl[1] + '/?dl=1';
            this.grabFromURL(dburl, 'dropbox', dburl[1], messageObj, callbacks, readOnly);
        }
        
        return true;
    }
    
    
    grabFromYoutube(url, messageObj, callbacks, readOnly) {
        let mp = this.obtainMessageParams(messageObj);        
        try {
            //Obtain metadata from youtube
            ytdl.getInfo(url, (err, info) => {
                if (err) {
                    this.log('warn', err);
                    return;
                }
                
                if (!mp.interval && info.length_seconds < this.param('minDuration') || mp.interval && mp.interval[1] - mp.interval[0] < this.param('minDuration')
                        || info.length_seconds > this.param('maxDuration') && (!mp.interval || mp.interval[1] - mp.interval[0] > this.param('maxDuration'))) {
                    if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                    return;
                }
                        
                if (this._indexSourceTypeAndId['youtube'] && this._indexSourceTypeAndId['youtube'][info.video_id]
                        && !this._indexSourceTypeAndId['youtube'][info.video_id].sourcePartial && !mp.interval) {
                    if (callbacks.exists) callbacks.exists(messageObj, mp.authorName, mp.reply, this._indexSourceTypeAndId['youtube'][info.video_id].hash);
                    return;
                }
                
                let keywords = info.keywords;
                if (typeof keywords == "string") {
                    if (keywords) keywords = keywords.split('');
                    else keywords = [];
                }
                for (let dkeyword of mp.info.keywords) {
                    keywords.push(dkeyword);
                }
                
                this.log('Grabbing from youtube: ' + url);
                this._downloads += 1;
            
                //Plug video download into ffmpeg
                let video = ytdl(url, {filter: 'audioonly'});
                let ffmpeg = new FFmpeg(video);
                
                ffmpeg.on('error', (err) => {
                    this.log('error', err);
                });
                
                if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
                
                //Prepare stream for writing to disk
                let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                let stream = fs.createWriteStream(temppath);
                
                stream.on('finish', () => {
                    this._downloads -= 1;
                
                    this.persistTempDownload(temppath, url, mp, {
                        length: parseInt(info.length_seconds),
                        source: url,
                        sourceType: 'youtube',
                        sourceSpecificId: info.video_id,
                        sourceLoudness: parseFloat(info.loudness),
                        name: info.title,
                        author: '',
                        album: '',
                        keywords: keywords
                    }, messageObj, callbacks, readOnly);
                });
                
                //Plug ffmpeg into writing stream
                let output = ffmpeg.format('mp3').pipe(stream);
                output.on('error', video.end.bind(video));
                output.on('error', stream.emit.bind(stream, 'error'));
            });
        } catch (exception) {
            this.log('error', exception);
        }
    }
    
    
    grabFromAttachment(ma, messageObj, callbacks, readOnly) {
        let mp = this.obtainMessageParams(messageObj);
        try {
            //Download attachment
            this.log('Grabbing from attachment: ' + ma.filename + ' (' + ma.id + ')');
            this._downloads += 1;
            let attfiledl = request(ma.url);
        
            //Plug attachment download into ffmpeg
            let ffmpeg = new FFmpeg(attfiledl);
            
            ffmpeg.on('error', (err) => {
                this.log('error', err);
            });
            
            if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
            
            //Prepare stream for writing to disk
            let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
            let stream = fs.createWriteStream(temppath);
            
            stream.on('finish', () => {
                this._downloads -= 1;
                
                //Get song info
                FFmpeg(temppath).ffprobe((err, info) => {
                    if (err) {
                        this.log('warn', err);
                        return;
                    }
    
                    let duration = parseFloat(info.format.duration || info.streams[0].duration);
                    if (duration < this.param('minDuration') || duration > this.param('maxDuration')) {
                        if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                        return;
                    }
                    
                    let title = ma.filename;
                    let artist = '';
                    let album = '';
                    if (info.format && info.format.tags) {
                        if (info.format.tags.title) title = info.format.tags.title;
                        if (info.format.tags.artist) artist = info.format.tags.artist;
                        if (info.format.tags.album) album = info.format.tags.album;
                    }
                    
                    let keywords = (mp.info.dkeywords || []);
                    
                    this.persistTempDownload(temppath, ma.filename, mp, {
                        length: Math.floor(duration),
                        source: ma.url,
                        sourceType: 'discord',
                        sourceSpecificId: ma.id,
                        sourceLoudness: null,
                        name: title,
                        author: artist,
                        album: album,
                        keywords: keywords
                    }, messageObj, callbacks, readOnly);
                });
                
            });
            
            //Plug ffmpeg into writing stream
            let output = ffmpeg.format('mp3').pipe(stream);
            output.on('error', attfiledl.end.bind(attfiledl));
            output.on('error', stream.emit.bind(stream, 'error'));
            
        } catch (exception) {
            this.log('error', exception);
        }
    }
    
    
    grabFromURL(url, sourceType, sourceSpecificId, messageObj, callbacks, readOnly) {
        let mp = this.obtainMessageParams(messageObj);
        try {
            let filename = sourceSpecificId;
        
            //Download
            this.log('Grabbing from ' + sourceType + ' URL: ' + url + ' (' + sourceSpecificId + ')');
            this._downloads += 1;
            let filedl = request(url);
            
            filedl.on('response', (response) => {
                
                if (response.headers['content-disposition']) {
                    let getfilename = response.headers['content-disposition'].match(/filename="([^"]+)"/);
                    if (getfilename) filename = getfilename[1];
                }
                
                //Plug attachment download into ffmpeg
                let ffmpeg = new FFmpeg(filedl);
                
                ffmpeg.on('error', (err) => {
                    this.log('error', err);
                });
                
                if (mp.interval) ffmpeg.seekInput(mp.interval[0]).duration(mp.interval[1] - mp.interval[0]);
                
                //Prepare stream for writing to disk
                let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                let stream = fs.createWriteStream(temppath);
                
                stream.on('finish', () => {
                    this._downloads -= 1;
                    
                    //Get song info
                    FFmpeg(temppath).ffprobe((err, info) => {
                        if (err) {
                            this.log('warn', err);
                            return;
                        }
        
                        let duration = parseFloat(info.format.duration || info.streams[0].duration);
                        if (duration < this.param('minDuration') || duration > this.param('maxDuration')) {
                            if (callbacks.errorDuration) callbacks.errorDuration(messageObj, mp.authorName, mp.reply, info.title);
                            return;
                        }
                        
                        let title = filename;
                        let artist = '';
                        let album = '';
                        if (info.format && info.format.tags) {
                            if (info.format.tags.title) title = info.format.tags.title;
                            if (info.format.tags.artist) artist = info.format.tags.artist;
                            if (info.format.tags.album) album = info.format.tags.album;
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
                            keywords: keywords
                        }, messageObj, callbacks, readOnly);
                    });
                    
                });
                
                //Plug ffmpeg into writing stream
                let output = ffmpeg.format('mp3').pipe(stream);
                output.on('error', filedl.end.bind(filedl));
                output.on('error', stream.emit.bind(stream, 'error'));
                
            });
            
        } catch (exception) {
            this.log('error', exception);
        }
    }
    
    
    /*
        temppath: Temporary location of downloaded song, already in mp3 format.
        originalname: Display name of the original for the downloaded song, for logging.
        mp: Result of this.obtainMessageParams
        info: Source-specific information for bootstrapping index fields. Must contain at least {source, sourceType, sourceSpecificId}
        messageObj, callbacks, readOnly: As passed to grabInMessage.
    */
    persistTempDownload(temppath, originalname, mp, info, messageObj, callbacks, readOnly) {
        //After the file is fully written, compute hash, rename file and add to index
        fs.readFile(temppath, (err, data) => {
            if (err) throw err;
            
            let hash = crypto.createHash('md5').update(data).digest('hex');
            let realpath = this.param('downloadPath') + '/' + hash + '.mp3';
            
            let now = moment().unix();
            
            if (fs.existsSync(realpath)) {
                fs.unlink(temppath);
                this.log('  Already existed: ' + originalname + '  (as ' + hash + ')');
                if (!readOnly) {
                    this._index[hash].seen.push(now);
                    if (this._index[hash].sharedBy.indexOf(mp.author) < 0) {
                        this._index[hash].sharedBy.push(mp.author);
                    }
                    this.saveIndex();
                }
                if (callbacks.exists) callbacks.exists(messageObj, mp.authorName, mp.reply, hash);
                return;
            } else if (data.toString().trim() == "") {
                this.log('  Temp file is empty: ' + hash);
                if (callbacks.errorEncoding) callbacks.errorEncoding(messageObj, mp.authorName, mp.reply);
                fs.unlink(temppath);
                return;
            } else if (mp.info.replace === false) {
                this.log('  No permission to commit replacement: ' + hash);
                if (callbacks.errorPermission) callbacks.errorPermission(messageObj, mp.authorName, mp.reply);
                fs.unlink(temppath);
                return;
            } else if (mp.info.replace && !this._index[mp.info.replace]) {
                this.log('  Target of replacement (' + mp.info.replace + ') not found for: ' + hash);
                if (callbacks.errorNotFound) callbacks.errorNotFound(messageObj, mp.authorName, mp.reply);
                fs.unlink(temppath);
                return;
            }
            
            if (readOnly) {
                fs.unlink(temppath);
                return;
            }
            
            this._usage += fs.statSync(temppath).size;
            
            fs.rename(temppath, realpath, (err) => {
                if (err) throw err;
            
                let entry = {};
                
                if (mp.info.replace) {
                    //Replacement
                    entry = this._index[mp.info.replace];
                    if (!entry.replaced) entry.replaced = [];
                    entry.replaced.push([mp.info.replace, mp.author, now]);
                    this.removeByHash(mp.info.replace);
                }
                
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
                            entry.keywords.push(keyword);
                        }
                    }
                }
                
                entry.hash = hash;
                entry.seen = [now];
                entry.sharedBy = [mp.author];
                if (mp.interval) entry.length = mp.interval[1] - mp.interval[0];
                entry.sourcePartial = mp.interval;
                if (mp.info.title) entry.name = mp.info.title;
                if (mp.info.artist) entry.author = mp.info.artist;
                if (mp.info.album) entry.album = mp.info.album;
                if (!entry.keywords) entry.keywords = [];

                this._index[hash] = entry;
                this.saveIndex();
                
                if (!this._indexSourceTypeAndId[entry.sourceType]) {
                    this._indexSourceTypeAndId[entry.sourceType] = {};
                }
                this._indexSourceTypeAndId[entry.sourceType][entry.sourceSpecificId] = this._index[hash];
                
                this._sessionGrabs.unshift([hash, now]);
                
                this.log('  Successfully grabbed from ' + entry.sourceType + ': ' + originalname + '  (as ' + hash + ')');
                if (callbacks.accepted) callbacks.accepted(messageObj, mp.authorName, mp.reply, hash);
                this.processOnNewSong(messageObj, mp.authorName, mp.reply, hash);
            });
            
        });
    }
    
    
    //Download path
    
    calculateDownloadPathUsage() {
        var total = 0;
        for (let file of fs.readdirSync(this.param('downloadPath'))) {
            if (!file.match(/\.mp3$/)) continue;
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
        let searchResult = this.parseSearchInMixedParam(hashoroffset);
        if (searchResult === true) return true;
        if (searchResult !== null) return searchResult.hash;
        
        if (!hashoroffset) hashoroffset = "-";
        else if (typeof hashoroffset != "string") return null;
        
        hashoroffset = hashoroffset.trim();
        var offset = hashoroffset.match(/^-([0-2]?[0-9])?/);
        if (offset) {
            if (offset[1] == 0) return null;
            if (!offset[1]) offset[1] = 1;
            offset = offset[1];
            if (offset > this._sessionGrabs.length) {
                return false;
            }
            return this._sessionGrabs[offset - 1][0];
        } else if (hashoroffset.length == 32) {
            return hashoroffset;
        }
        
        for (let item of this._parserFilters) {
            let mr = hashoroffset.match(item[0]);
            if (!mr) continue;
            return item[1](hashoroffset, mr, userid);
        }
        
        return null;
    }
    
    removeByHash(hash) {
        if (!this._index[hash]) return false;
        fs.unlink(this.param('downloadPath') + '/' + hash + '.mp3');
        delete this._index[hash];
        this.saveIndex();
        return true;
    }
    
    
    dequeueAndScan() {
        if (!this._scanQueue) return;
        if (this._downloads >= this.param('maxSimDownloads')) return;
        var item = this._scanQueue.shift();
        if (!item) return;
        if (!item[1]) item[1] = {};
        if (!item[2]) item[2] = false;
        this.grabInMessage(item[0], item[1], item[2]);
    }
    
    
    filterSongsBySearchString(searchstr) {
        var filters = searchstr.split(' & ');
        if (!filters.length) return [];
        
        var results = [];
        for (let hash in this._index) results.push(this._index[hash]);

        for (let filter of filters) {
            let regexfilter = new RegExp(filter.replace(/[-\/\\^$*+?.()|[\]{}]/gu, '\\$&').replace(' ', '.*'), 'i');
            results = results.filter(
                (info) => info.hash.match(regexfilter) || info.sharedBy.find((e, i, a) => e.match(regexfilter)) || info.source.match(regexfilter) || info.name.match(regexfilter) || info.author.match(regexfilter) || info.keywords.find((e, i, a) => e.match(regexfilter))
            );
        }
        
        return results;
    }
    
    parseSearchInMixedParam(str) {
        let extract = str.match(/^\(([^)]+)\)$/);
        if (!extract) return null;
        var songs = this.filterSongsBySearchString(extract[1]);
        if (songs.length > 1) {
            return true;
        } else if (songs.length == 1) {
            return songs[0];
        }
        return null;
    }
    
    
    parseInterval(intervalstring) {  //"00:00:00,23:59:59" => [minseconds, maxseconds]
        if (!intervalstring) return [0, 0];
        var parts = intervalstring.split(',');
        var min = parts[0] || "0";
        var max = parts[1] || String(Number.MAX_SAFE_INTEGER);
        var minparts = min.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        var actualmin = (minparts ? parseInt(minparts[5]) + (parseInt(minparts[4])||0) * 60 + (parseInt(minparts[3])||0) * 3600 : 0);
        var maxparts = max.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        var actualmax = (maxparts ? parseInt(maxparts[5]) + (parseInt(maxparts[4])||0) * 60 + (parseInt(maxparts[3])||0) * 3600 : Number.MAX_SAFE_INTEGER);
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
    
    
    // # API #
    
    
    randomSong() {
        var allhashes = Object.keys(this._index);
        if (!allhashes.length) return null;
        var hash = allhashes[Math.floor(random.fraction() * allhashes.length)];
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
        var songs = this.filterSongsBySearchString(searchstr);
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
        return this.param('downloadPath') + '/' + hash + '.mp3';
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
        this.saveIndex();
        return true;
    }


    addSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        var ret = false;
        if (this._index[hash].keywords.indexOf(keyword) < 0) {
            this._index[hash].keywords.push(keyword);
            this.saveIndex();
            ret = true;
        }
        return ret;
    }
    
    removeSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        let ind = this._index[hash].keywords.indexOf(keyword);
        var ret = false;
        if (ind > -1) {
            this._index[hash].keywords.splice(ind, 1);
            this.saveIndex();
            ret = true;
        }
        return ret;
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
    
    
    //Filter callback signature: hashoroffset, matchresult
    registerParserFilter(regex, func, self) {
        this.log('Registering parser filter. Context: ' + self.constructor.name);
        this._parserFilters.push([regex, func]);
    }
    
    
    scanMessage(messageObj, callbacks, readOnly) {
        this._scanQueue.push([messageObj, callbacks, readOnly]);
    }
    

}


module.exports = ModGrabber;
