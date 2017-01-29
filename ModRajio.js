/* Module: Rajio -- Grabber add-on for playing songs on discord audio channels. */

var Module = require('./Module.js');

const TYPE_AUTO = "auto";
const TYPE_MANUAL = "manual";

class ModRajio extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channel',              //ID of a Discord audio channel
        'grabber'               //Name of the grabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Rajio', name);
        
        this._dj = null;
        this._queue = [];
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }
    
    get dchan() {
        return this.denv.server.channels[this.param('channel')];
    }
    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') {
            this.log('error', "Grabber not found.");
            return false;
        }
        
        if (!this.denv || this.denv.envName != 'Discord') {
            this.log('error', "Environment not found or not Discord.");
            return false;
        }
        
        if (!this.dchan || this.chan.type != "voice") {
            this.log('error', "Channel not found or not a voice channel.");
            return false;
        }
        
        
        //Prepare player
        
        chan.join().then((connection) => {
            playSong();
        });
        
        
        //Register callbacks

        var self = this;
        
        denv.client.on("voiceStateUpdate", (oldMember, member) => {
            
        });

        /*
        this.mod('Commands').registerCommand(this, 'songrank', {
            description: 'Displays the global (balanced) rank of a song.',
            args: ['hash']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var rank = this.computeSongRank(args.hash);
            if (rank !== null) {
                ep.reply("Rank: " + rank);
            } else {
                ep.reply("Song is unranked.");
            }
        
            return true;
        });
        */


        return true;
    }
    
    
    // # Module code below this line #
    
    
    playSong() {
        var vc = this.denv.server.voiceConnection;
        if (!vc || vc.speaking) return false;
        var song = this.grabber.randomSong();
        if (!song) return false;
        vc.playFile(this.grabber.songPathByHash(song.hash)).once("end", playSong());
        return true;
    }
    
    
}


module.exports = ModRajio;
