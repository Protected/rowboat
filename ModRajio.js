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
        'pri.rank.mtotal',      //Multiplier for global song rank
        'pri.rank.mlistener',   //Multiplier for listener-specific song rank
        'pri.request.bonus',    //Added priority for songs in request queue
        'pri.request.mpos',     //Multiplier for position of songs in request queue
        'pri.length.minlen',    //Minimum ideal song length (for maximum priority bonus)
        'pri.length.maxlen',    //Maximum ideal song length (for maximum priority bonus)
        'pri.length.maxexcs',   //Song length after which priority bonus is 0
        'pri.length.bonus',     //Bonus priority for ideal song length
        'pri.lastplay.cap',     //Seconds in the past after which recently played bonus no longer applies
        'pri.lastplay.m',       //Bonus priority multiplier for recently played song
        'pri.lastplay.b',       //Bonus base for recently played song
        'pri.lastreq.cap',      //Seconds in the past after which recently requested bonus no longer applies
        'pri.lastreq.m',        //Bonus priority multiplier for recently requested song
        'pri.lastreq.b',        //Bonus base for recently requested song
        'pri.kw.high',          //Bonus multiplier for user-defined high priority keywords
        'pri.kw.low',           //Bonus multiplier for user-defined low priority keywords (bonus will be negative)
        'pri.kw.max',           //Maximum amount of user-defined priority keywords
        'pri.kw.global',        //{"keyword" => {bonus, multiplier, mindate, maxdate}, ...} Modify priority if each keyword is found in song (dates are month-day)
        'pri.rand.min',         //Minimum random component        
        'pri.rand.max',         //Maximum random component
        'pri.tolerance'         //Tolerance when selecting a song (select randomly in interval)
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
        this._params['historylength'] = 5;
        
        this._params['pri.base'] = 0.0;
        this._params['pri.rank.mtotal'] = 10.0;
        this._params['pri.rank.mlistener'] = 20.0;
        this._params['pri.request.bonus'] = 50.0;
        this._params['pri.request.mpos'] = 15.0;
        this._params['pri.length.minlen'] = 200;
        this._params['pri.length.maxlen'] = 600;
        this._params['pri.length.maxexcs'] = 900;
        this._params['pri.length.bonus'] = 20.0;
        this._params['pri.lastplay.cap'] = 43200;
        this._params['pri.lastplay.m'] = 0.4;
        this._params['pri.lastplay.b'] = -30.0;
        this._params['pri.lastreq.cap'] = 3600;
        this._params['pri.lastreq.m'] = 0.8;
        this._params['pri.lastreq.b'] = -25.0;
        this._params['pri.kw.high'] = 5.0;
        this._params['pri.kw.low'] = 5.0;
        this._params['pri.kw.max'] = 3;
        this._params['pri.kw.global'] = {};
        this._params['pri.rand.min'] = -25.0;
        this._params['pri.rand.max'] = 25.0;
        this._params['pri.tolerance'] = 20.0;
        
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
        return this.dchan.members.filter((member) => member.id != me.id && !member.deaf).array();
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
            
            if (oldMember.voiceChannelID != this.dchan.id && member.voiceChannelID == this.dchan.id) {
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
            
            if (oldMember.voiceChannelID == this.dchan.id && member.voiceChannelID != this.dchan.id) {
                if (member.id == myid) {
                    //I left the channel
                    this.stopSong();
                } else {
                    this.autowithdraw(member.id);
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
                    if (this._skipper[member.id] && member.voiceChannelID == this.dchan.id) {
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
        
        this.grabber.registerParserFilter(/^#$/, (str, match) => {
            if (this._play) return this._play.hash;
            return null;
        }, this);
        

        //Register commands

        this.mod("Commands").registerRootDetails(this, 'rajio', {description: 'Commands for controlling the radio queue and playback.'});

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
        
        
        this.mod('Commands').registerCommand(this, 'rajio next', {
            description: 'Show the next song in the queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._queue.length) {
                let song = this._queue[0].song;
                let reqby = '';
                if (this._queue[0].userid) {
                    reqby = ' ** Requested by __' + this.denv.idToDisplayName(this._queue[0].userid) + '__';
                }
                ep.reply('**[Up next]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`' + reqby);
            } else {
                ep.reply('The queue is empty; The next song will be selected automatically.');
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
            permissions: [PERM_ADMIN]
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
            
            ep.reply(this.songPriority(this.grabber.hashSong(hash), this.listeners.map((listener) => listener.id)));
        
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
        
        if (!song) song = this.dequeue();
        if (!song || !song.hash) return false;
        
        this.log('Playing song: ' + song.hash);
        
        if (this.param('announcechannel') && (!this._announced || moment().unix() > this._announced + this.param('announcedelay'))) {
            let anchan = this.denv.server.channels.get(this.param('announcechannel'));
            if (anchan) {
                anchan.send('**[Now Playing]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + ' <' + this.secondsToHms(song.length) + '>`');
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
                if (this._play) this.remember(this._play);
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
        
        this.playSong(this._pause[0], this._pause[1]);
        
        this._pause = null;
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
    
    dequeue() {
        let listeners = this.listeners.map((listener) => listener.id);
    
        let priorities = {};
        let maxpri = Number.MIN_VALUE;
        for (let hash of this.grabber.everySong()) {
            let priority = this.songPriority(this.grabber.hashSong(hash), listeners);
            maxpri = Math.max(maxpri, priority);
            priorities[hash] = priority;
        }
        
        let candidates = [];
        for (let hash in priorities) {
            if (priorities[hash] >= maxpri - this.param('pri.tolerance')) {
                candidates.push(hash);
            }
        }
        
        let hash = candidates[Math.floor(random.fraction() * candidates.length)];
        
        let index = this._queue.findIndex((item) => item.song.hash == hash);
        if (index > -1) {
            this._lastreq[hash] = moment().unix();
            this._queue.splice(index, 1);
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
        let members = this.dchan.members;
        for (let userid in this._skipper) {
            if (members.get(userid) && members.get(userid).deaf) {
                members.get(userid).setDeaf(false);
                delete this._skipper[userid];
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
        this.grabber.setSongMeta(song.hash, "rajio." + this.name.toLowerCase()  + ".lastplayed", moment().unix());
    }
    
    
    //Auxiliary
    
    islistener(userid) {
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
            keyword = keyword.toLowerCase().trim();
            for (let listener of listeners) {
                let userdata = this._userdata[listener];
                if (!userdata || !userdata.kw || !userdata.kw[keyword]) continue;
                result += userdata.kw[keyword] * this.param(userdata.kw[keyword] > 0 ? "pri.kw.high" : "pri.kw.low");
            }
        }
        
        return result;
    }
    
    
    songPriority(song, listeners) {
        let priority = this.param('pri.base');
        
        priority += this.param('pri.rand.min') + random.fraction() * (this.param('pri.rand.max') - this.param('pri.rand.min'));
        
        let songrank = this.songrank;
        if (songrank) {
            priority += songrank.computeSongRank(song.hash, null) * this.param('pri.mtotal');
            if (listeners) priority += songrank.computeSongRank(song.hash, listeners) * this.param('pri.mlistener');
        }
        
        let queuepos = this._queue.findIndex((item) => item.song.hash == song.hash);
        if (queuepos > -1) {
            priority += this.param('pri.request.bonus');
            priority += (this.param('queuesize') - queuepos - 1) * this.param('pri.request.mpos');
        }
        
        if (song.length >= this.param('pri.length.minlen') && song.length <= this.param('pri.length.maxlen')) {
            priority += this.param('pri.length.bonus');
        } else if (song.length < this.param('pri.length.minlen')) {
            priority += this.param('pri.length.bonus') * (song.length / this.param('pri.length.minlen'));
        } else if (song.length > this.param('pri.length.maxlen') && song.length < this.param('pri.length.maxexcs')) {
            priority += this.param('pri.length.bonus') * ((this.param('pri.length.maxexcs') - song.length) / (this.param('pri.length.maxexcs') - this.param('pri.length.maxlen')));
        }
        
        let now = moment().unix();
        
        let lastplayed = song["rajio." + this.name.toLowerCase()  + ".lastplayed"];
        if (lastplayed && lastplayed > now - this.param('pri.lastplay.cap')) {
            let coef = (lastplayed - now + this.param('pri.lastplay.cap')) / this.param('pri.lastplay.cap');
            priority += coef * this.param('pri.lastplay.b');
            let mul = (this.param('pri.lastplay.m') - 1) * coef + 1;
            if (priority > 0) priority *= mul;
            if (priority < 0) priority *= Math.abs(mul - 1);
        }
        
        let lastreq = this._lastreq[song.hash];
        if (lastreq && lastreq > now - this.param('pri.lastreq.cap')) {
            let coef = (lastreq - now + this.param('pri.lastreq.cap')) / this.param('pri.lastreq.cap');
            priority += coef * this.param('pri.lastreq.b');
            let mul = (this.param('pri.lastreq.m') - 1) * coef + 1;
            if (priority > 0) priority *= mul;
            if (priority < 0) priority *= Math.abs(mul - 1);
        }
        
        priority += this.personalPriorityBonus(song.keywords, listeners);
        
        for (let keyword in this.param('pri.kw.global')) {
            let descriptor = this.param('pri.kw.global')[keyword];
            if (descriptor.multiplier == 1 && !descriptor.bonus) continue;
            if (!song.keywords.find((kw) => kw.toLowerCase().trim() == keyword.toLowerCase().trim())) continue;
            if (descriptor.mindate && descriptor.maxdate) {
                let now = moment();
                if (!now.isAfter(now.year() + '-' + descriptor.mindate + ' 00:00:00')) continue;
                if (!now.isBefore(now.year() + '-' + descriptor.maxdate + ' 23:59:59')) continue;
            }
            priority = priority * descriptor.multiplier + (descriptor.bonus || 0);
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
