/* Module: Rajio -- Grabber add-on for playing songs on discord audio channels. */

var Module = require('./Module.js');
var moment = require('moment');

const PERM_ADMIN = 'administrator';
const PERM_MOD = 'moderator';


class ModRajio extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channel',              //ID of a Discord audio channel
        'grabber'               //Name of the grabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get optionalParams() { return [
        'leadin',               //Length of silence, in seconds, before each new song is played
        'pause',                //Maximum amount of time in seconds to keep the current song paused when the module loses all listeners
        'queuesize',            //Maximum amount of songs in the queue
        'referenceloudness',    //Negative decibels; Play youtube songs with higher loudness at a lower volume to compensate
        'volume',               //Global volume multipler; Defaults to 1.0 and can be changed via command
        'announcechannel'       //ID of a Discord text channel to announce song changes to
        'announcedelay'         //Minimum seconds between announces
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Rajio', name);
        
        this._params['leadin'] = 2;
        this._params['pause'] = 900;
        this._params['queuesize'] = 5;
        this._params['referenceloudness'] = -20;
        this._params['volume'] = 1.0;
        this._params['announcechannel'] = null;
        this._params['announcedelay'] = 0;
        
        this._announced = null;
        
        this._queue = [];  //[{song, userid}, ...] - plays from the left
        this._disabled = false;
        this._volume = 1.0;
        
        this._play = null;  //Song being played
        this._pending = null;  //Timer that will start the next song
        this._pause = null;  //[song, seek] for resuming paused song
        this._expirepause = null;  //Timer that will expire (stop) a paused song
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }
    
    get dchan() {
        return this.denv.server.channels.get(this.param('channel'));
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
        
        
        this._volume = parseFloat(this.param('volume'));
        
        
        //Prepare player
        
        this.denv.on("connected", () => {
            if (!this.dchan || this.dchan.type != "voice") {
                this.log('error', "Channel not found or not a voice channel.");
                return;
            }
        
            this.dchan.join().then((connection) => {
                if (this.listeners.length) {
                    this.playSong();
                }
            });
        });
            
        
        
        //Register callbacks

        var self = this;
        
        this.denv.client.on("voiceStateUpdate", (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            let myid = this.denv.server.me.id;
            
            if (oldMember.voiceChannelID != this.dchan.id && member.voiceChannelID == this.dchan.id) {
                if (member.id == myid && this.listeners.length) {
                    //I joined the channel
                    this.playSong();
                } else if (!member.deaf && !this.playing) {                    
                    //First listener joined the channel
                    this.resumeSong() || this.playSong();
                }
            }
            
            if (oldMember.voiceChannelID == this.dchan.id && member.voiceChannelID != this.dchan.id) {
                if (member.id == myid) {
                    //I left the channel
                    this.stopSong();
                } else if (!this.listeners.length) {
                    //Last listener left the channel
                    this.pauseSong();
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
                if (!oldMember.deaf && member.deaf && !this.listeners.length) {
                    //Last listener was deafened
                    this.pauseSong();
                } else if (oldMember.deaf && !member.deaf) {
                    //First listener was undeafened
                    this.resumeSong() || this.playSong();
                }
            }
            
        });
        
        
        this.denv.client.on('presenceUpdate', (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            if (oldMember.user.presence.status != "offline" && member.user.presence.status == "offline") {
                this.widthdraw(member.user.id);
            }
        });
        
        this.denv.client.on("guildMemberRemove", (member) => {
            if (member.user.presence.status == "offline") return;
            if (member.guild.id != this.denv.server.id) return;
            this.widthdraw(member.user.id);
        });
        


        this.mod("Commands").registerRootDetails(this, 'rajio', {description: 'Commands for controlling the radio queue and playback.'});

        this.mod('Commands').registerCommand(this, 'rajio now', {
            description: 'Displays the name and hash of the song currently being played.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._play) {
                if (this._pause) {
                    ep.reply('**[Paused]** ' + '`' + this._pause[0].hash + ' ' + this._pause[0].name + (this._pause[0].author ? ' (' + this._pause[0].author + ')' : '')
                        + ' <' + this.secondsToHms(this._pause[1]) + ' / ' + this.secondsToHms(this._pause[0].length) + '>`');
                } else {
                    ep.reply('Nothing is being played right now.');
                }
            } else {
                let vc = this.denv.server.voiceConnection;
                ep.reply('**[Playing]** ' + '`' + this._play.hash + ' ' + this._play.name + (this._play.author ? ' (' + this._play.author + ')' : '')
                    + ' <' + (vc && vc.dispatcher ? this.secondsToHms(vc.dispatcher.time) + ' / ' : '') + this.secondsToHms(this._play.length) + '>`');
            }
        
            return true;
        });
        

        this.mod('Commands').registerCommand(this, 'rajio off', {
            description: 'Disable the radio. This will stop it from playing music until it\'s re-enabled.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is already disabled.');
            } else {
                this._disabled = true;
                this.stopSong();
                ep.reply('The radio has now been disabled.');
            }
        
            return true;
        });

        
        this.mod('Commands').registerCommand(this, 'rajio on', {
            description: 'Re-enable the radio if it was previously disabled.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._disabled) {
                ep.reply('The radio is not disabled!');
            } else {
                this._disabled = false;
                if (this.listeners.length) {
                    this.playSong();
                }
                ep.reply('The radio has now been re-enabled.');
            }
        
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
        
            this.stopSong();
            this.playSong();
        
            return true;
        });
        
        
        let requestcommand = (demand) => (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }
        
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


        return true;
    }
    
    
    // # Module code below this line #
    
    
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
        
        let att = 1.0;
        let ref = this.param('referenceloudness');
        if (!isNaN(ref) && ref < 0) {
            if (song.sourceLoudness && song.sourceLoudness > ref) {  //Both negative numbers
                att = ref / song.sourceLoudness;
            }
        }
        
        let options = {
            volume: this._volume * att,
            seek: (seek ? Math.round(seek / 1000.0) : 0)
        };
        
        this._play = song;
        this._pending = setTimeout(() => {
            vc.playFile(this.grabber.songPathByHash(song.hash), options).once("end", () => {
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
        
        if (this._pending) {
            clearTimeout(this._pending);
            this._pending = null;
        }
        
        if (this._expirepause) {
            clearTimeout(this._expirepause);
            this._expirepause = null;
        }
        
        if (vc.dispatcher) {
            this._play = null;
            this._pause = true;  //Hack to stop the end event from playing next song
            vc.dispatcher.end();
        }
        
        this._pause = null;
    }
    
    pauseSong() {
        let vc = this.denv.server.voiceConnection;
        if (!vc || !vc.speaking || !vc.dispatcher) {
            return this.stopSong();
        }
        
        this.log('Pausing song: ' + this._play.hash + ' at ' + vc.dispatcher.time);
        
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
    
    
    enqueue(song, userid, demand) {
        if (!song) return false;
        if (!demand && this._queue.length >= this.param('queuesize')) return false;
        if (this._queue.find((item) => item.song.hash == song.hash)) return false;
        if (demand) {
            this._queue.unshift({
                song: song,
                userid: userid
            });
            this._queue = this._queue.slice(0, this.param('queuesize'));
        } else {
            this._queue.push({
                song: song,
                userid: userid
            });
        }
        return true;
    }
    
    dequeue() {
        if (!this._queue.length) return this.grabber.randomSong();
        let item = this._queue.shift();
        return item.song;
    }
    
    withdraw(userid) {
        let newqueue = this._queue.filter((item) => item.userid != userid);
        let result = 0;
        if (newqueue.length != this._queue.length) {
            result = this._queue.length - newqueue.length;
            this.log('User ' + userid + ' withdrew from the queue. Removed ' + result + ' song(s).');
            this._queue = newqueue;
        }
        return result;
    }
    
    
    islistener(userid) {
        let member = this.dchan.members.get(userid);
        return member && !member.deaf;
    }
    
    
    secondsToHms(seconds) {
        let h = Math.floor(s / 3600.0);
        seconds = seconds % 3600;
        let m = Math.floor(seconds / 60.0);
        seconds = seconds % 60;
        let result = ('0' + seconds).slice(-2);
        if (m) result = ('0' + m).slice(-2) + ':' + result;
        if (h) result = ('0' + h).slice(-2) + ':' + result;
        return result;
    }
    
}


module.exports = ModRajio;
