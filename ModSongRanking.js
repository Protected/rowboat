/* Module: SongRanking -- Grabber add-on for liking/disliking songs and rating them. */

var Module = require('./Module.js');


class ModSongRanking extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channels',             //List of IDs of the Discord channels to be used
        'grabber'               //Name of the grabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('SongRanking', name);        
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        if (!this.grabber || !this.grabber.modName != 'Grabber') return false;
        
        
        //Register callbacks

        var self = this;
        this.grabber.registerOnNewSong((hash, author, message, messageObj) => {
            
            this.setSongLikeability(hash, author, 0);
            
        }, self);
        
        
        this.mod('Commands').registerCommand('songlike', {
            description: 'Assigns a personal like level to a song in the index.',
            args: ['hash', 'likeability'],
            details: [
                "Likeability can be one of:",
                " 1 = :ok_hand: = I especially like the song",
                " 0 = :slight_smile: = (default) The song is ok/good",
                "-1 = :slight_frown: = The song is bad/don't like it much",
                "-2 = :poop: = I hate this song"
            ],
            minArgs: 1
        }, (env, type, userid, command, args, handle, reply) => {
        
            var lik = args.likeability || 0;
            if (parseInt(lik) == NaN) lik = 0;
            if (parseInt(lik) < -2) lik = -2;
            if (parseInt(lik) > 1) lik = 1;
        
            if (this.setSongLikeability(args.hash, userid, parseInt(lik))) {
                reply("Ok.");
            } else {
                reply("Song not found or invalid argument.");
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand('songrank', {
            description: 'Displays the global (balanced) rank of a song.',
            args: ['hash']
        }, (env, type, userid, command, args, handle, reply) => {
        
            var rank = this.computeSongRank(args.hash);
            if (rank) {
                reply("Rank: " + rank);
            } else {
                reply("Song is unranked.");
            }
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    setSongLikeability(hash, userid, likeability) {
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) likmap = {};
        likmap[userid] = likeability;
        this.grabber.setSongMeta(hash, "like", likmap);
    }
    
    
    getSongLikeability(hash, userid) {
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return null;
        return likmap[userid];
    }
    
    
    computeSongRank(hash, users) {  //users is a list of Discord userids
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!users || !users.length) {
            users = Object.keys(likmap);
        }
        var i = 0; 
        var acc = 0;
        for (let userid in likmap) {
            if (users.indexOf(userid) > -1) {
                acc += likmap[userid];
                i += 1;
            }
        }
        acc /= i;
        return acc;
    }
    
    
}


module.exports = ModSongRanking;
