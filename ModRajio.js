/* Module: Rajio -- Grabber add-on for playing songs on discord audio channels. */

var Module = require('./Module.js');
var moment = require('moment');
var random = require('meteor-random');
var fs = require('fs');
var jsonfile = require('jsonfile');

const PERM_ADMIN = 'administrator';
const PERM_MOD = 'moderator';


class ModRajio extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'grabber'               //Name of the ModGrabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get optionalParams() { return [
        'datafile',
        
        'channel',              //ID of a Discord audio channel to join by default
        'songrank',             //Name of the ModSongRank to obtain user preferences from
        'leadin',               //Length of silence, in seconds, before each new song is played
        'pause',                //Maximum amount of time in seconds to keep the current song paused when the module loses all listeners
        'autowithdraw',         //How long in seconds before a user withdraws from the queue if they are online but not a listener
        'queuesize',            //Maximum amount of songs in the request queue
        'referenceloudness',    //Negative decibels; Play youtube songs with higher loudness at a lower volume to compensate
        'volume',               //Global volume multipler; Defaults to 1.0 and can be changed via command
        
        'announcechannel',      //ID of a Discord text channel to announce song changes to
        'announcedelay',        //Minimum seconds between announces
        'announcestatus',       //Announce current song in bot's game (true/false)
        'historylength',        //Maximum amount of recently played songs to remember
        
        'pri.base',             //Base priority
        'pri.min',              //Minimum priority
        'pri.max',              //Maximum priority not counting queue
        'pri.rank.mtotal',      //Multiplier for global song rank
        'pri.rank.mlistener',   //Multiplier for listener-specific song rank
        'pri.request.mbonus',   //Maximum added priority per library item for songs at top of request queue
        'pri.history.bonus',    //Maximum added priority for songs recently played in history
        'pri.length.minlen',    //Minimum ideal song length (for no priority penalty)
        'pri.length.maxlen',    //Maximum ideal song length (for no priority penalty)
        'pri.length.maxexcs',   //Song length after which priority bonus is 0
        'pri.length.penalty',   //Bonus priority for non-ideal song length (Gradient between ]0, min[; ]max, maxexcs[)
        'pri.lastplay.cap',     //Seconds in the past after which recently played bonus no longer applies
        'pri.lastplay.bonus',   //Bonus base for recently played song
        'pri.lastreq.cap',      //Seconds in the past after which recently requested bonus no longer applies
        'pri.lastreq.bonus',    //Bonus base for recently requested song
        'pri.novelty.cap',      //Seconds in the past after which a song is no longer new
        'pri.novelty.bonus',    //Bonus base for new song
        'pri.plays.mplay',      //Multiplier of bonus per play
        'pri.plays.exp',        //Exponent of bonus per play    m*plays^e
        'pri.skip.cutoff',      //Minimum (included) listener-specific song rank for listener's skip to count towards making skip applicable
        'pri.skip.cap',         //Seconds in the past after which a skip no longer yields the bonus
        'pri.skip.mbonus',      //Skip bonus: mbonus * applicable_skips; all skips are cleared after song plays successfully
        'pri.kw.high',          //Bonus multiplier for user-defined high priority keywords
        'pri.kw.low',           //Bonus multiplier for user-defined low priority keywords (bonus will be negative)
        'pri.kw.max',           //Maximum amount of user-defined priority keywords
        'pri.kw.global'         //{"keyword" => {bonus, mindate, maxdate}, ...} Modify priority if each keyword is found in song (dates are month-day)
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Rajio', name);
        
        this._params['datafile'] = 'rajio.data.json';
        
        this._params['channel'] = null;
        this._params['songrank'] = null;
        this._params['leadin'] = 2;
        this._params['pause'] = 900;
        this._params['autowithdraw'] = 120;
        this._params['queuesize'] = 10;
        this._params['referenceloudness'] = -20;
        this._params['volume'] = 1.0;
        
        this._params['announcechannel'] = null;
        this._params['announcedelay'] = 0;
        this._params['announcestatus'] = true;
        this._params['historylength'] = 10;
        
        this._params['pri.base'] = 80.0;
        this._params['pri.min'] = 3.0;
        this._params['pri.max'] = 250.0;
        this._params['pri.rank.mtotal'] = 8.0;
        this._params['pri.rank.mlistener'] = 35.0;
        this._params['pri.request.mbonus'] = 120.0;
        this._params['pri.history.bonus'] = -120.0;
        this._params['pri.length.minlen'] = 200;
        this._params['pri.length.maxlen'] = 600;
        this._params['pri.length.maxexcs'] = 900;
        this._params['pri.length.penalty'] = -30.0;
        this._params['pri.lastplay.cap'] = 259200;
        this._params['pri.lastplay.bonus'] = -100.0;
        this._params['pri.lastreq.cap'] = 10800;
        this._params['pri.lastreq.bonus'] = -40.0;
        this._params['pri.novelty.cap'] = 259200;
        this._params['pri.novelty.bonus'] = 20.0;
        this._params['pri.plays.mplay'] = -2.8;
        this._params['pri.plays.exp'] = 0.8;
        this._params['pri.skip.cutoff'] = 0;
        this._params['pri.skip.cap'] = 169200;
        this._params['pri.skip.mbonus'] = -20.0;
        this._params['pri.kw.high'] = 10.0;
        this._params['pri.kw.low'] = 10.0;
        this._params['pri.kw.max'] = 5;
        this._params['pri.kw.global'] = {};
        
        this._userdata = {};
        
        this._announced = null;
        this._history = [];  //[song, song, ...]
        
        this._queue = [];  //[{song, userid}, ...] - plays from the left
        this._lastreq = {};  //{hash: ts, ...} - When a requested song was last played (not persisted)
        this._disabled = false;
        this._volume = 1.0;
        
        this._pendingwithdraw = {};  //{userid: timer, ...} Autowithdrawal for non-listeners with queued songs
        this._skipper = {};  //{userid: true, ...} Requested skipping current song
        this._undeafen = {};  //{userid: true, ...} Users to undeafen as soon as they rejoin a voice channel
        this._nopreference = {};  //{userid: true, ...} Users have disabled impact of their preferences in priority calculations
        
        this._play = null;  //Song being played
        this._pending = null;  //Timer that will start the next song
        this._pause = null;  //[song, seek] for resuming paused song
        this._expirepause = null;  //Timer that will expire (stop) a paused song
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get songrank() {
        if (!this.param('songrank')) return null;
        return this.mod(this.param('songrank'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }
    
    get dchan() {
        return this.denv.server.channels.get(this._channel);
    }
    
    get listeners() {
        let me = this.denv.server.me;
        if (me.mute) return [];
        let dchan = this.dchan;
        if (!dchan) return [];
        return dchan.members.filter((member) => member.id != me.id && !member.deaf).array();
    }
    
    get playing() {
        return this.denv.server.voiceConnection && this.denv.server.voiceConnection.speaking || this._pending;
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') {
            this.log('error', "Grabber not found.");
            return false;
        }
        
        if (!this.denv || this.denv.envName != 'Discord') {
            this.log('error', "Environment not found or not Discord.");
            return false;
        }
        
        
        this._params['datafile'] = this.dataPath() + this._params['datafile'];
        this.loadData();
        
        
        this._channel = this.param('channel');
        this._volume = parseFloat(this.param('volume'));
        
        
        //Prepare player
        
        this.denv.on("connected", () => {
            if (this.dchan && this.dchan.type == "voice") {
                this.dchan.join().then((connection) => {
                    if (this.listeners.length) {
                        this.playSong();
                    }
                });
            } else {
                this._disabled = true;
            }
        });
            
        
        
        //Register Discord callbacks

        var self = this;
        
        this.denv.client.on("voiceStateUpdate", (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            let myid = this.denv.server.me.id;
            let llisteners = this.listeners.length;
            let dchanid = null;
            if (this.dchan) dchanid = this.dchan.id;
            
            if (oldMember.voiceChannelID != dchanid && member.voiceChannelID == dchanid) {
                if (member.id == myid) {
                    if (llisteners) {
                        //I joined the channel
                        this.playSong();
                    }
                } else {
                    if (this._skipper[member.id] && !member.deaf) {
                        //Skipper tried to undeafen themselves... Nah
                        member.setDeaf(true);
                    } else {
                        if (this._undeafen[member.id]) {
                            member.setDeaf(false);
                            delete this._undeafen[member.id];
                        }
                        if (!member.deaf) {
                            if (!this.playing) {
                                //First listener joined the channel
                                this.resumeSong() || this.playSong();
                            }
                            this.stayafterall(member.id);
                        }
                    }
                }
            }
            
            if (oldMember.voiceChannelID == dchanid && member.voiceChannelID != dchanid) {
                if (member.id == myid) {
                    //I left the channel
                    this.stopSong();
                } else {
                    this.autowithdraw(member.id);
                    if (this._nopreference[member.id]) delete this._nopreference[member.id];
                    if (!llisteners) {
                        //Last listener left the channel
                        this.pauseSong();
                    }
                }
            }
            
            if (member.id == myid) {
                if (!oldMember.mute && member.mute) {
                    //I was muted
                    this.pauseSong();
                }
                if (oldMember.mute && !member.mute) {
                    //I was unmuted
                    this.resumeSong() || this.playSong();
                }
            } else {
                if (!oldMember.deaf && member.deaf) {
                    if (!llisteners) {
                        //Last listener was deafened
                        this.pauseSong();
                    }
                } else if (oldMember.deaf && !member.deaf) {
                    if (this._skipper[member.id] && member.voiceChannelID == dchanid) {
                        //Skipper tried to undeafen themselves... Nah
                        member.setDeaf(true);
                    } else if (llisteners == 1) {
                        //First listener was undeafened
                        this.resumeSong() || this.playSong();
                    }
                }
            }
            
        });
        
        
        this.denv.client.on('presenceUpdate', (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            if (oldMember.user.presence.status != "offline" && member.user.presence.status == "offline") {
                this.withdraw(member.user.id);
            }
        });
        
        this.denv.client.on("guildMemberRemove", (member) => {
            if (member.user.presence.status == "offline") return;
            if (member.guild.id != this.denv.server.id) return;
            this.withdraw(member.user.id);
        });
        
        
        //Register module integrations
        
        this.grabber.registerParserFilter(/^[#$]([0-9]+)?$/, (str, match, userid) => {
            if ((!match[1] || match[1] == "0") && this._play) return this._play.hash;
            if (match[1] && this._history[match[1] - 1]) {
                return this._history[match[1] - 1].hash;
            }
            return null;
        }, this);
        

        //Register commands

        this.mod("Commands").registerRootDetails(this, 'rajio', {
            description: 'Commands for controlling the radio queue and playback.',
            details: [
                'This feature adds the #NUMBER expansion to song library hash arguments, representing the currently playing song or a recently played song.'
            ]
        });

        this.mod('Commands').registerCommand(this, 'rajio now', {
            description: 'Displays the name and hash of the song currently being played.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is disabled.');
                return true;
            }
        
            if (!this._play) {
                if (this._pause) {
                    ep.reply('**[Paused]** ' + '`' + this._pause[0].hash + ' ' + this._pause[0].name + (this._pause[0].author ? ' (' + this._pause[0].author + ')' : '')
                        + ' <' + this.secondsToHms(Math.round(this._pause[1] / 1000.0)) + ' / ' + this.secondsToHms(this._pause[0].length) + '>`');
                } else {
                    ep.reply('Nothing is being played right now.');
                }
            } else {
                let vc = this.denv.server.voiceConnection;
                ep.reply('**[Playing]** ' + '`' + this._play.hash + ' ' + this._play.name + (this._play.author ? ' (' + this._play.author + ')' : '')
                    + ' <' + (vc && vc.dispatcher ? this.secondsToHms(Math.round(vc.dispatcher.time / 1000.0)) + ' / ' : '') + this.secondsToHms(this._play.length) + '>`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio skip', {
            description: 'Vote to skip the current song.',
            details: [
                "When a listener calls this command, if there are no listeners who haven't called it, the current song is skipped.",
                "Otherwise, the listener is deafened until the end of the song and a beep is played in the channel to alert other listeners.",
                "If the listener leaves the channel or undeafens himself, his skip vote is revoked."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.playing || this._skipper[userid] || !this.islistener(userid)) return true;
            
            let listeners = this.listeners;
            
            let cskippers = Object.keys(this._skipper).length;
            let clisteners = listeners.length;
            
            for (let skipperid in this._skipper) {
                if (!listeners.find((item) => item.id == skipperid)) {
                    clisteners += 1;
                }
            }
            
            ep.reply('OK (' + (cskippers+1) + '/' + clisteners + ').');
            
            this._skipper[userid] = true;
            
            if (cskippers >= clisteners - 1) {
                let prefix = "rajio." + this.name.toLowerCase();
                let skipdata = this.grabber.getSongMeta(this._play.hash, prefix + ".skipped");
                if (!skipdata) skipdata = {};
                
                let now = moment().unix();
                skipdata[now] = Object.keys(this._skipper);
                this.grabber.setSongMeta(this._play.hash, prefix + ".skipped", skipdata);

                this.stopSong();                
                this.playSong();
                return true;
            }
                        
            this.dchan.members.get(userid).setDeaf(true);
            
            let vc = this.denv.server.voiceConnection;
            //vc.playFile('beep.ogg');
        
            return true;
        });
        

        this.mod('Commands').registerCommand(this, 'rajio off', {
            description: 'Disable the radio. This will stop it from playing music.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is already disabled.');
                return true;
            }
            
            this._disabled = true;
            this.stopSong();
            
            if (this.dchan) {
                this.dchan.leave();
            }
            
            ep.reply('The radio has now been disabled.');

            return true;
        });

        
        this.mod('Commands').registerCommand(this, 'rajio on', {
            description: 'Enable or re-enable the radio in an existing voice channel.',
            args: ['channelid'],
            minArgs: 0,
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._disabled) {
                ep.reply('The radio is already running!');
                return true;
            }

            if (args.channelid) {
                let newchan = this.denv.server.channels.get(args.channelid);
                if (!newchan || newchan.type != "voice") {
                    ep.reply('There is no voice channel with the specified ID.');
                    return true;
                }
                this._channel = args.channelid;
            } else {
                let me = this.denv.server.members.get(userid);
                if (me && me.voiceChannelID) {
                    this._channel = me.voiceChannelID;
                }
            }
            
            if (!this.dchan || this.dchan.type != "voice") {
                ep.reply("The voice channel could not be found. Please specify the ID of an existing voice channel.");
                return true;
            }
            
            this.dchan.join().then((connection) => {
                this._disabled = false;
                if (this.listeners.length) {
                    this.playSong();
                }
                ep.reply('The radio has now been re-enabled.');
            });
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio volume', {
            description: 'Adjust the master volume attenuation.',
            args: ['volume'],
            details: [
                "Use a value between 0.0 (no sound) and 1.0 (maximum)."
            ],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let volume = parseFloat(args.volume);
            if (isNaN(volume) || volume < 0 || volume > 1) {
                ep.reply('Please specify a number between 0.0 and 1.0 .');
                return true;
            }
            
            this._volume = volume;
            ep.reply('OK.');
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio another', {
            description: 'End playback of the current song and play the next one in the queue.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) return true;
        
            this.stopSong();
            this.playSong();
        
            return true;
        });
        
        
        let requestcommand = (demand) => (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            if (args.hashoroffset.length > 1 && !arg.match(/^\(.*\)$/)) {
                arg = '(' + arg + ')';
            }
        
            let hash = this.grabber.bestSongForHashArg(arg, userid);
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
            
            let song = this.grabber.hashSong(hash);
            if (!this.enqueue(song, userid, demand)) {
                ep.reply('The queue is full or the song is already in the queue.');
                return true;
            }
            
            if (!this.islistener(userid)) {
                this.autowithdraw(userid);
            }
            
            ep.reply('OK.');
        
            return true;
        }
        
        this.mod('Commands').registerCommand(this, 'rajio request', {
            description: 'Requests playback of a song in the library, which will be added to the queue if possible.',
            args: ['hashoroffset', true]
        }, requestcommand(false));
        
        this.mod('Commands').registerCommand(this, 'rajio demand', {
            description: 'Puts a song from the library at the top of the queue.',
            args: ['hashoroffset', true],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, requestcommand(true));
        
        
        this.mod('Commands').registerCommand(this, 'rajio withdraw', {
            description: 'Withdraws all your requests from the queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let result = this.withdraw(userid);
            if (result) {
                ep.reply('Removed your ' + (result > 1 ? result + ' requests' : 'request') + ' from the queue.');
            } else {
                ep.reply('You made no requests!');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio queue', {
            description: 'Show a summary of the contents of the queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }
        
            if (this._queue.length) {
                for (let i = 0; i < this._queue.length; i++) {
                    let song = this._queue[i].song;
                    let width = String(this.param('queuesize')).length;        //
                    let pos = ('0'.repeat(width) + String(i+1)).slice(-width); //0-padded i
                    ep.reply('`[' + pos + '] ' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
                }
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio history', {
            description: 'Show a list of recently played songs.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._history.length) {
                ep.reply('No songs were played.');
                return true;
            }
            
            for (let song of this._history) {
                if (!song) continue;
                ep.reply('`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio neutral', {
            description: 'Toggle whether my likes and priorities will affect song selection while I\'m listening.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }
        
            if (this._nopreference[userid]) {
                delete this._nopreference[userid];
                ep.reply('Disabled neutral mode: Re-enabled the use of your preferences in song selection.');
            } else {
                this._nopreference[userid] = true;
                ep.reply('Enabled neutral mode: Your preferences will no longer be used in song selection until the end this session. You can also repeat this command to return to normal.');
            }
        
            return true;
        });

        
        if (this.param('pri.kw.max')) {
        
            this.mod('Commands').registerCommand(this, 'rajio kwpriority', {
                description: 'List your personal priorities.'
            }, (env, type, userid, channelid, command, args, handle, ep) => {
                
                let userdata = this._userdata[userid];
                if (!userdata) userdata = {};
                
                if (!userdata.kw || !Object.keys(userdata.kw).length) {
                    ep.reply('You have set no priorities.');
                    return true;
                }
                
                for (let keyword in userdata.kw) {
                    ep.reply('[' + (userdata.kw[keyword] > 0 ? 'High' : 'Low') + '] ' + keyword);
                }
                
                return true;
            });
        
            this.mod('Commands').registerCommand(this, 'rajio kwpriority set', {
                description: 'Set a personal priority (high or low) for a keyword.',
                args: ['level', 'keyword', true]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
                            
                let level = 0;
                if (args.level == "high") level = 1;
                else if (args.level == "low") level = -1;
                else {
                    ep.reply('Please set the priority level to "high" or "low".');
                    return true;
                }
            
                let keyword = args.keyword.join(" ").toLowerCase().trim();
                
                if (!keyword.match(/^[a-zA-Z90-9_ !?.-]{3,}$/)) {
                    ep.reply('Your keyword match must have at least 3 characters and contain only A-Z, 0-9 and the special characters _ - ! ? . and space.');
                    return true;
                }
            
                let userdata = this._userdata[userid];
                if (!userdata) userdata = {};
                if (!userdata.kw) userdata.kw = {};
                
                if (Object.keys(userdata) >= this.param('pri.kw.max') && !userdata.kw[keyword]) {
                    ep.reply('You can\'t have more than ' + this.param('pri.kw.max') + ' keyword preferences.');
                    return true;
                }
                
                userdata.kw[keyword] = level;
                this._userdata[userid] = userdata;
                this.saveData();
                
                ep.reply('OK.');
            
                return true;
            });
            
            this.mod('Commands').registerCommand(this, 'rajio kwpriority unset', {
                description: 'Unset a keyword\'s personal priority.',
                args: ['keyword', true]
            }, (env, type, userid, channelid, command, args, handle, ep) => {
            
                let keyword = args.keyword.join(" ").toLowerCase().trim();
            
                let userdata = this._userdata[userid];
                if (!userdata) userdata = {};
                if (!userdata.kw) userdata.kw = {};
                
                if (!userdata.kw[keyword]) {
                    ep.reply('You do not have a priority for this keyword.');
                    return true;
                }
                
                delete userdata.kw[keyword];
                this._userdata[userid] = userdata;
                this.saveData();
                
                ep.reply('OK.');
            
                return true;
            });
            
        }
        
        
        this.mod('Commands').registerCommand(this, 'rajio priority', {
            description: 'Show a song\'s current priority value.',
            args: ['hashoroffset', true],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            
            let hash = this.grabber.bestSongForHashArg(arg);
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
            
            let prioritycomponents = this.songPriority(this.grabber.hashSong(hash), this.listeners.map((listener) => listener.id), true);
            
            ep.reply(prioritycomponents.priority - prioritycomponents.random);
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio apriority', {
            description: 'Analyze a song\'s current priority value.',
            args: ['hashoroffset', true],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            
            let hash = this.grabber.bestSongForHashArg(arg);
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
            
            let prioritycomponents = this.songPriority(this.grabber.hashSong(hash), this.listeners.map((listener) => listener.id), true);
            
            for (let cname in prioritycomponents) {
                ep.reply('`' + cname + ' = ' + prioritycomponents[cname] + '`');
            }
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    //Internal playback control
    
    playSong(song, seek) {
        let vc = this.denv.server.voiceConnection;
        if (!vc || vc.speaking || this._pending
                || this.denv.server.me.mute || !this.listeners.length || this._disabled) {
            return false;
        }
        
        if (!song) song = this.dequeue(true);
        let userid = song[1];
        song = song[0];
        
        if (!song || !song.hash) return false;
        
        this.log('Playing song: ' + song.hash);
        
        if (this.param('announcechannel') && (!this._announced || moment().unix() > this._announced + this.param('announcedelay'))) {
            let anchan = this.denv.server.channels.get(this.param('announcechannel'));
            if (anchan) {
                let reqby = '';
                if (userid) {
                    reqby = ' ** Requested by __' + this.denv.idToDisplayName(userid) + '__';
                }
                anchan.send('**[Now Playing]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + ' <' + this.secondsToHms(song.length) + '>`' + reqby);
                this._announced = moment().unix();
            }
        }
        
        if (this.param('announcestatus')) {
            this.denv.client.realClient.user.setGame(song.name);
        }
        
        let att = 1.0;
        let ref = this.param('referenceloudness');
        if (!isNaN(ref) && ref < 0) {
            if (song.sourceLoudness && song.sourceLoudness > ref) {  //Both negative numbers
                att = Math.pow(10, (ref - song.sourceLoudness) / 20);
            }
        }
        
        let options = {
            volume: this._volume * att,
            seek: (seek ? Math.round(seek / 1000.0) : 0)
        };
        
        this._play = song;
        this._pending = setTimeout(() => {
        
            this.abortskip();
        
            vc.playFile(this.grabber.songPathByHash(song.hash), options).once("end", () => {
                if (this._play) {
                    this.remember(this._play);
                }
                if (!this._pause) {
                    this.playSong();
                }
            });
            
            this._pending = null;
        }, this.param('leadin') > 0 ? this.param('leadin') * 1000 : 1);
        
        return true;
    }
    
    stopSong() {
        let vc = this.denv.server.voiceConnection;
        
        this.log('Stopping song' + (this._play ? ': ' + this._play.hash : '.'));
        
        if (this.param('announcestatus')) {
            this.denv.client.realClient.user.setGame(null);
        }
        
        if (this._pending) {
            clearTimeout(this._pending);
            this._pending = null;
        }
        
        if (this._expirepause) {
            clearTimeout(this._expirepause);
            this._expirepause = null;
        }
        
        if (vc && vc.dispatcher) {
            this._play = null;
            this._pause = true;  //Hack to stop the end event from playing next song
            vc.dispatcher.end();
        }
        
        this._pause = null;
        
        this.abortskip();
    }
    
    pauseSong() {
        let vc = this.denv.server.voiceConnection;
        if (!vc || !vc.speaking || !vc.dispatcher) {
            return this.stopSong();
        }
        
        this.log('Pausing song: ' + this._play.hash + ' at ' + vc.dispatcher.time);
        
        if (this.param('announcestatus')) {
            this.denv.client.realClient.user.setGame("*Paused*");
        }
        
        this._pause = [this._play, vc.dispatcher.time];
        this._play = null;
        vc.dispatcher.end();
        
        this._expirepause = setTimeout(() => {
            this.log('Expiring paused song: ' + this._pause[0].hash);
            this.stopSong();
            this._expirepause = null;
        }, this.param('pause') > 0 ? this.param('pause') * 1000 : 1);
    }
    
    resumeSong() {
        if (!this._pause) return false;
        
        this.log('Preparing to resume song: ' + this._pause[0].hash + ' at ' + this._pause[1]);
        
        let song = this._pause[0];
        let seek = this._pause[1];
        
        this._pause = null;
        
        this.playSong(song, seek);
        
        if (this._expirepause) {
            clearTimeout(this._expirepause);
            this._expirepause = null;
        }
        
        return true;
    }
    
    
    //Control the queue of pending/upcoming songs
    
    enqueue(song, userid, demand) {
        if (!song) return false;
        if (this._queue.find((item) => item.song.hash == song.hash)) return false;
        
        if (demand) {
            this._queue.unshift({
                song: song,
                userid: userid
            });
            this._queue = this._queue.slice(0, this.param('queuesize'));
            return true;
        }
        
        let countbyuser = {};
        let max = 0;
        for (let item of this._queue) {
            if (!countbyuser[item.userid]) {
                countbyuser[item.userid] = 1;
                max = Math.max(max, 1);
            } else {
                countbyuser[item.userid] += 1;
                max = Math.max(max, countbyuser[item.userid]);
            }
        }
        
        let newitem = {
            song: song,
            userid: userid
        };
        
        if (!max || countbyuser[userid] >= max) {
            if (this._queue.length >= this.param('queuesize')) return false;
            this._queue.push(newitem);
        } else {
            this._queue.splice(((countbyuser[userid] || 0) + 1) * Object.keys(countbyuser).length, 0, newitem);
            this._queue = this._queue.slice(0, this.param('queuesize'));
        }
        
        return true;
    }
    
    dequeue(getrequester) {
        let listeners = this.listeners.map((listener) => listener.id);
    
        let priorities = {};
        for (let hash of this.grabber.everySong()) {
            let priority = this.songPriority(this.grabber.hashSong(hash), listeners);
            priorities[hash] = priority;
        }
        
        let sum = 0;
        let candidates = [];
        for (let hash in priorities) {
            sum += priorities[hash];
            candidates.push([hash, sum]);
        }
        
        let pick = random.fraction() * sum;
        let selection = null;
        for (let item of candidates) {
            selection = item;
            if (pick < item[1]) break;
        }
        if (!selection) selection = candidates[candidates.length - 1];
        
        let hash = selection[0];
        
        let index = this._queue.findIndex((item) => item.song.hash == hash);
        let userid = null;
        if (index > -1) {
            userid = this._queue[index].userid;
            this._lastreq[hash] = moment().unix();
            this._queue.splice(index, 1);
        }
        
        if (getrequester) {
            return [this.grabber.hashSong(hash), userid];
        }
        
        return this.grabber.hashSong(hash);
    }
    
    withdraw(userid, fromauto) {
        let newqueue = this._queue.filter((item) => item.userid != userid);
        let result = 0;
        if (newqueue.length != this._queue.length) {
            result = this._queue.length - newqueue.length;
            this.log('User ' + userid + ' withdrew from the queue. Removed ' + result + ' song(s).');
            this._queue = newqueue;
        }
        if (!fromauto && this._pendingwithdraw[userid]) {
            clearTimeout(this._pendingwithdraw[userid]);
            this._pendingwithdraw[userid] = null;
        }
        return result;
    }
    
    autowithdraw(userid) {
        if (this._pendingwithdraw[userid]) return;
        this._pendingwithdraw[userid] = setTimeout(() => {
            this.withdraw(userid, true);
            this._pendingwithdraw[userid] = null;
        }, this.param('autowithdraw') * 1000);
    }
    
    stayafterall(userid) {
        if (!this._pendingwithdraw[userid]) return;
        clearTimeout(this._pendingwithdraw[userid]);
        this._pendingwithdraw[userid] = null;
    }
    
    
    //Abort request to skip current song
    
    abortskip() {
        if (this.dchan) {
            let members = this.dchan.members;
            for (let userid in this._skipper) {
                if (members.get(userid) && members.get(userid).deaf) {
                    members.get(userid).setDeaf(false);
                    delete this._skipper[userid];
                }
            }
        }
        for (let userid in this._skipper) {
            this._undeafen[userid] = true;
        }
        this._skipper = {};
    }
    
    
    //Remember played song
    
    remember(song) {
        this._history.unshift(song);
        if (this._history.length > this.param('historylength')) {
            this._history = this._history.slice(0, this.param('historylength'));
        }
        
        let prefix = "rajio." + this.name.toLowerCase();
        this.grabber.setSongMeta(song.hash, prefix + ".lastplayed", moment().unix());
        this.grabber.setSongMeta(song.hash, prefix + ".plays", (this.grabber.getSongMeta(song.hash, prefix + ".plays") || 0) + 1);
        this.grabber.setSongMeta(song.hash, prefix + ".skipped", null);
    }
    
    
    //Auxiliary
    
    islistener(userid) {
        if (!this.dchan) return false;
        let member = this.dchan.members.get(userid);
        return member && !member.deaf;
    }
    
    
    secondsToHms(seconds) {
        let h = Math.floor(seconds / 3600.0);
        seconds = seconds % 3600;
        let m = Math.floor(seconds / 60.0);
        seconds = seconds % 60;
        let result = ('0' + seconds).slice(-2);
        result = ('0' + m).slice(-2) + ':' + result;
        if (h) result = ('0' + h).slice(-2) + ':' + result;
        return result;
    }
    
    
    personalPriorityBonus(keywords, listeners) {
        let result = 0;
        if (!keywords || !listeners) return result;
        
        for (let keyword of keywords) {
           for (let listener of listeners) {
                let userdata = this._userdata[listener];
                if (!userdata || !userdata.kw) continue;
                for (let keywordmatch in userdata.kw) {
                    if (keyword.match(new RegExp('^' + keywordmatch.replace(/[-\/\\^$*+?.()|[\]{}]/gu, '\\$&').replace(' ', '.*') + '$'))) {
                        result += userdata.kw[keywordmatch] * this.param(userdata.kw[keywordmatch] > 0 ? "pri.kw.high" : "pri.kw.low");
                    }
                }
            }
        }
        
        return result;
    }
    
    
    songPriority(song, listeners, trace) {
        let prefix = "rajio." + this.name.toLowerCase();
        let priority = this.param('pri.base');
        let components = {base: priority};
        
        if (listeners) {
            let prelisteners = listeners;
            listeners = [];
            for (let userid of prelisteners) {
                if (this._nopreference[userid]) continue;
                listeners.push(userid);
            }
        }
        
        
        //Rank-based components
        
        let songrank = this.songrank;
        
        if (songrank) {
            let crank = (songrank.computeSongRank(song.hash, null) || 0) * this.param('pri.rank.mtotal');
            priority += crank;
            if (trace) components.rank = crank;
            
            if (listeners) {
                let clrank = (songrank.computeSongRank(song.hash, listeners) || 0) * this.param('pri.rank.mlistener');
                priority += clrank;
                if (trace) components.listenerrank = clrank;
            }
        }
        
        //Position in history
        
        let historypos = this._history.findIndex((item) => item.hash == song.hash);
        if (historypos > -1) {
            let chistory = (this.param('historylength') - historypos) / this.param('historylength') * this.param('pri.history.bonus');
            priority += chistory;
            if (trace) components.history = chistory;
        }
        
        
        //Proximity to optimal length
        
        let clength = 0;
        if (song.length >= this.param('pri.length.maxexcs')) {
            clength = this.param('pri.length.penalty');
        } else if (song.length > this.param('pri.length.maxlen') && song.length < this.param('pri.length.maxexcs')) {
            clength = this.param('pri.length.penalty') * ((song.length - this.param('pri.length.maxlen')) / (this.param('pri.length.maxexcs') - this.param('pri.length.maxlen')));
        } else if (song.length < this.param('pri.length.minlen')) {
            clength = this.param('pri.length.penalty') * ((this.param('pri.length.minlen') - song.length) / this.param('pri.length.minlen'));
        }
        priority += clength;
        if (trace) components.length = clength;
        
        
        //Time-based components (last played, last requested, novelty)
        
        let now = moment().unix();
        
        let lastplayed = song[prefix + ".lastplayed"];
        if (lastplayed && lastplayed > now - this.param('pri.lastplay.cap')) {
            let coef = (lastplayed - now + this.param('pri.lastplay.cap')) / this.param('pri.lastplay.cap');
            let clplayed = Math.pow(coef, 2) * this.param('pri.lastplay.bonus');
            priority += clplayed;
            if (trace) components.lastplayed = clplayed;
        }
        
        let lastreq = this._lastreq[song.hash];
        if (lastreq && lastreq > now - this.param('pri.lastreq.cap')) {
            let coef = (lastreq - now + this.param('pri.lastreq.cap')) / this.param('pri.lastreq.cap');
            let clreq = coef * this.param('pri.lastreq.bonus');
            priority += clreq;
            if (trace) components.lastreq = clreq;
        }
        
        let earliestseen = song.seen.reduce((min, item) => Math.min(min, item), Number.MAX_SAFE_INTEGER);
        if (earliestseen > now - this.param('pri.novelty.cap')) {
            let coef = (earliestseen - now + this.param('pri.novelty.cap')) / this.param('pri.novelty.cap');
            let cnovelty = coef * this.param('pri.novelty.bonus');
            priority += cnovelty;
            if (trace) components.novelty = cnovelty;
        }
        
        
        //Skips (Use song rank and time)
        
        let skipdata = song[prefix + ".skipped"];
        if (skipdata) {
            let applicable = 0;
            priaplskipcounter: for (let ts in skipdata) {
                if (ts < now - this.param('pri.skip.cap')) continue;
                for (let userid of skipdata[ts]) {
                    if (songrank.getSongLikeability(song.hash, userid) < this.param('pri.skip.cutoff')) {
                        applicable += 1;
                        continue priaplskipcounter;
                    }
                }
            }
            let cskips = applicable * this.param('pri.skip.mbonus');
            priority += cskips;
            if (trace) components.skips = cskips;
        }
        
        
        //Amount of times played
        
        let plays = song[prefix + ".plays"];
        if (plays) {
            let coef = Math.pow(plays, this.param('pri.plays.exp'));
            let cplays = coef * this.param('pri.plays.mplay');
            priority += cplays;
            if (trace) components.plays = cplays;
        }

        
        //Keywords
        
        let allwords = this.grabber.allSongWords(song.hash);
        
        let ckwpri = this.personalPriorityBonus(allwords, listeners);
        priority += ckwpri;
        if (trace) components.kwpriority = ckwpri;
        
        let ckwglobal = [];
        for (let keyword in this.param('pri.kw.global')) {
            let descriptor = this.param('pri.kw.global')[keyword];
            if (!descriptor.bonus) continue;
            if (!allwords.find((kw) => kw.toLowerCase().trim().match(new RegExp('^' + keyword.toLowerCase().trim().replace(/[-\/\\^$*+?.()|[\]{}]/gu, '\\$&').replace(' ', '.*') + '$')))) continue;
            if (descriptor.mindate && descriptor.maxdate) {
                let now = moment();
                if (!now.isAfter(now.year() + '-' + descriptor.mindate + ' 00:00:00')) continue;
                if (!now.isBefore(now.year() + '-' + descriptor.maxdate + ' 23:59:59')) continue;
            }
            priority += descriptor.bonus;
            if (trace) ckwglobal.push(descriptor.bonus);
        }
        if (trace) components.kwglobal = ckwglobal.reduce((comp, bonus) => comp + bonus, 0);
        
        
        //Wrap it up
        
        if (trace) components.subtotal = priority;
        
        if (priority < this.param('pri.min')) priority = this.param('pri.min');
        if (priority > this.param('pri.max')) priority = this.param('pri.max');
        
        let queuepos = this._queue.findIndex((item) => item.song.hash == song.hash);
        if (queuepos > -1) {
            let cqueue = (this.param('queuesize') - queuepos) / this.param('queuesize') * this.param('pri.request.mbonus') * this.grabber.everySong().length;
            priority += cqueue;
            if (trace) components.queue = cqueue;
        }
        if (priority < 0) priority = 0;

        
        if (trace) {
            components.priority = priority;
            return components;
        }
        
        return priority;
    }
    
    
    //Load and save data file
    
    loadData() {
        var datafile = this.param('datafile');
     
        try {
            fs.accessSync(datafile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(datafile, {});
        }

        try {
            this._userdata = jsonfile.readFileSync(datafile);
        } catch (e) {
            return false;
        }
        if (!this._userdata) this._userdata = {};
        
        return true;
    }

    saveData() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFileSync(datafile, this._userdata);
    }
    
}


module.exports = ModRajio;
