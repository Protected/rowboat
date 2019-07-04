/* Module: SongRanking -- Grabber add-on for liking/disliking songs and rating them. */

const Module = require('./Module.js');
const emoji = require('emojione');
const random = require('meteor-random');

const LIKEABILITY_WORDS = {
    love: 2,
    adore: 2,
    blissful: 2,
    enraptured: 2,
    epiphany: 2,
    wow: 2,
    incredible: 2,
    ok: 1,
    like: 1,
    decent: 1,
    happy: 1,
    acceptable: 1,
    yes: 1,
    sure: 1,
    mediocre: -1,
    dislike: -1,
    unhappy: -1,
    unimpressed: -1,
    underwhelming: -1,
    no: -1,
    nah: -1,
    nope: -1,
    hate: -2,
    horrible: -2,
    terrible: -2,
    disgust: -2,
    never: -2,
    poop: -2,
    remove: 0,
    delete: 0,
    erase: 0,
    clear: 0
};

const LIKEABILITY_REACTIONS = {
    ok_hand: 2,
    thumbsup: 2,
    clap: 2,
    laughing: 2,
    satisfied: 2,
    heart_eyes: 2,
    heart: 2,
    hearts: 2,
    smile: 1,
    smiley: 1,
    slight_smile: 1,
    grin: 1,
    grinning: 1,
    relieved: 1,
    relaxed: 1,
    metal: 1,
    weary: -1,
    slight_frown: -1,
    expressionless: -1,
    unamused: -1,
    disappointed: -1,
    worried: -1,
    frowning: -1,
    anguished: -1,
    sleepy: -1,
    grimacing: -1,
    poop: -2,
    rage: -2,
    thumbsdown: -2,
    nauseated_face: -2,
    sick: -2
};

const LIKEABILITY_ICONS = {
    "-2": 'poop',
    "-1": 'nauseated_face',
    "1": 'slight_smile',
    "2": 'ok_hand'
};


/*
    SongRanking additions to Grabber stats (for each userid):
    {..., likes: {LEVEL: COUNT, ...}, likesonshares: {LEVEL: COUNT, ...}}
*/


class ModSongRanking extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'grabber'               //Name of the grabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get optionalParams() { return [
        'scaleExtremists',      //Scale down -2/2 votes of people who have more than X times as many of those votes as -1/1 votes
        'allowRemoval',         //Allow users to remove their votes from the index by voting 0
        'preventLastRemoval'    //Prevent removal of a vote from the index if it's the last vote associated with an entry
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('SongRanking', name);
        
        this._params['scaleExtremists'] = 1.0;
        this._params['allowRemoval'] = true;
        this._params['preventLastRemoval'] = true;
        
        this._index = {};  //{USERID: {LIKEABILITY: [HASH, ...], ...}, ...}
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') return false;
        

        //Build index
        
        for (let hash of this.grabber.everySong()) {
            let likmap = this.grabber.getSongMeta(hash, "like");
            for (let userid in likmap) {
                if (!this._index[userid]) this._index[userid] = {};
                if (!this._index[userid][likmap[userid]]) this._index[userid][likmap[userid]] = [];
                this._index[userid][likmap[userid]].push(hash);
            }
        }
 
        
        //Register callbacks

        let self = this;
        
        this.grabber.registerOnNewSong((messageObj, messageAuthor, reply, hash) => {
            
            this.setSongLikeability(hash, messageObj.author.id, 1);
            
        }, self);

        this.grabber.registerOnGrabscanExists((messageObj, messageAuthor, reply, hash) => {

            for (let messageReaction of messageObj.reactions.array()) {
                let emojiname = '';
                let extr = emoji.toShort(messageReaction.emoji.name).match(/\:([^:]+)\:/);
                if (!extr) continue;
                emojiname = extr[1];
                if (LIKEABILITY_REACTIONS[emojiname] === undefined) continue;
                
                let likeability = LIKEABILITY_REACTIONS[emojiname];
                if (this.getSongLikeability(hash, messageObj.author.id) === likeability) continue;
                
                this.setSongLikeability(hash, messageObj.author.id, likeability);
            }
            
        }, self);
        
        this.grabber.registerOnRemoveSong((hash, ismoderator, removerid) => {
        
            let like = this.grabber.getSongMeta(hash, 'like');

            if (!ismoderator) {
                for (let userid in like) {
                    if (userid != removerid) {
                        //Abort song deletion if a non-moderator tried to delete a song with votes from others
                        return true;
                    }
                }
            }

            for (let userid in like) {
                
                let likestats = this.grabber.getUserStat(userid, 'likes');
                if (likestats && likestats[like[userid]]) {
                    likestats[like[userid]] -= 1;
                }
                this.grabber.setUserStat(userid, 'likes', likestats);
                
                for (let sharer of this.grabber.getSongMeta(hash, 'sharedBy')) {
                    
                    let losstats = this.grabber.getUserStat(sharer, 'likesonshares');
                    if (losstats && losstats[like[userid]]) {
                        losstats[like[userid]] -= 1;
                    }
                    this.grabber.setUserStat(sharer, 'likesonshares', losstats);   
                    
                }
                
            }
        
        }, self);
        
        
        this.denv.on('connected', (env) => {
        
            this.grabber.setAdditionalStats('icons', this.likeabilityIcons);
            this.computeStatsIntoGrabberIndex(true);
        
            env.client.on('messageReactionAdd', (messageReaction, user) => {
                if (!messageReaction.message.channel || messageReaction.message.channel.guild.id != env.server.id) return;
                
                let emojiname = '';
                let extr = emoji.toShort(messageReaction.emoji.name).match(/\:([^:]+)\:/);
                if (!extr) return;
                emojiname = extr[1];
                if (LIKEABILITY_REACTIONS[emojiname] === undefined) return;
                
                this.grabber.scanMessage(messageReaction.message, {
                    exists: (messageObj, messageAuthor, reply, hash) => {
                        this.setSongLikeability(hash, user.id, LIKEABILITY_REACTIONS[emojiname]);
                    }
                }, true);
            });
            
        }, self);
        
        
        //Register module integrations
        
        this.grabber.registerParserFilter(/^&(-?[12])?$/, (str, match, userid) => {
            if (!userid) return null;
            let likeability = (match[1] || 0);
            if (!likeability) return this.grabber.randomSong().hash;
            if (!this._index[userid] || !this._index[userid][likeability] || !this._index[userid][likeability].length) return null;
            return this._index[userid][likeability][Math.floor(random.fraction() * this._index[userid][likeability].length)];
        }, this);
        
        
        //Register commands
        
        this.mod('Commands').registerRootExtension(this, 'Grabber', 'song');
        
        
        let details = [
            "Likeability can be one of:",
            " 2 = :ok_hand: = I especially like the song",
            " 1 = :slight_smile: = (default) The song is ok/good",
            "-1 = :worried: = The song is bad/don't like it much",
            "-2 = :poop: = I hate this song"
        ];

        if (this.param('allowRemoval')) {
            details.splice(3, 0, " 0 = Remove a previous vote" + (this.param('preventLastRemoval') ? " (if it isn't the last in the song)" : ""));
        }

        this.mod('Commands').registerCommand(this, 'song like', {
            description: 'Assigns a personal like level to a song in the index.',
            args: ['hashoroffset', 'likeability'],
            details: details,
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (env.name != this.param('env')) return true;
            
            let hash = this.grabber.bestSongForHashArg(args.hashoroffset);
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
        
            let lik = args.likeability || 1;
            lik = parseInt(lik);
            if (isNaN(lik)) {
                if (LIKEABILITY_WORDS[args.likeability] !== undefined) lik = LIKEABILITY_WORDS[args.likeability];
                else lik = 1;
            }
            if (lik < -2) lik = -2;
            if (lik > 2) lik = 2;
            
            if (lik == 0) {
                //Removal
                if (!this.param('allowRemoval')) {
                    ep.reply("?");
                    return true;
                }
                if (this.param('preventLastRemoval') && Object.keys(this.getAllSongLikes(hash)).length == 1) {
                    ep.reply("The last vote in a song can't be removed.");
                    return true;
                }
                if (this.unsetSongLikeability(hash, userid)) {
                    ep.reply("Ok.");
                } else {
                    ep.reply("Song not found.");
                }
                return true;
            }
        
            if (this.setSongLikeability(hash, userid, parseInt(lik))) {
                ep.reply("Ok.");
            } else {
                ep.reply("Song not found or invalid argument.");
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'song rank', {
            description: 'Displays the rank of a song.',
            args: ['hashoroffset']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let hash = this.grabber.bestSongForHashArg(args.hashoroffset);
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
            
            let yourvotepart = '';
            let yourvote = this.getSongLikeability(hash, userid);
            if (yourvote) {
                yourvotepart = ' (Your opinion: ' + yourvote + ')';
            }

            let rank = this.computeSongRank(hash);
            if (rank !== null) {
                ep.reply("Rank: " + rank + yourvotepart);
            } else {
                ep.reply("Song is unranked.");
            }
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    computeStatsIntoGrabberIndex(firstrun) {
        if (!firstrun) {
            this.grabber.cleanUserStats('likes');
            this.grabber.cleanUserStats('likesonshares');
        }
        
        for (let hash of this.grabber.everySong()) {
            let like = this.grabber.getSongMeta(hash, 'like');
            for (let userid in like) {
                
                let likestats = this.grabber.getUserStat(userid, 'likes');
                if (!likestats) likestats = {};
                if (!likestats[like[userid]]) likestats[like[userid]] = 0;
                likestats[like[userid]] += 1;
                this.grabber.setUserStat(userid, 'likes', likestats, true);
                
                for (let sharer of this.grabber.getSongMeta(hash, 'sharedBy')) {
                    
                    let losstats = this.grabber.getUserStat(sharer, 'likesonshares');
                    if (!losstats) losstats = {};
                    if (!losstats[like[userid]]) losstats[like[userid]] = 0;
                    losstats[like[userid]] += 1;
                    this.grabber.setUserStat(sharer, 'likesonshares', losstats, true);   
                    
                }
                
            }
        }
        
        this.grabber.saveStats();  //!! Not in API.
    }
    
    
    setSongLikeability(hash, userid, likeability) {
        this.log('Setting ' + userid + ' likeability of ' + hash + ' to ' + likeability);
        
        //Add new likeability to songrank index
        if (!this._index[userid]) this._index[userid] = {};
        if (!this._index[userid][likeability]) this._index[userid][likeability] = [];
        this._index[userid][likeability].push(hash);
        
        //Fetch likeabilities of song
        let likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) likmap = {};
        
        //Remove old likeability from songrank index if necessary
        if (likmap[userid] && likmap[userid] != likeability) {
            this._index[userid][likmap[userid]] = this._index[userid][likmap[userid]].filter((item) => item != hash);
        }
        
        //Statistics
        
        let likestats = this.grabber.getUserStat(userid, 'likes');
        if (!likestats) likestats = {};
        if (!likestats[likeability]) likestats[likeability] = 0;
        likestats[likeability] += 1;
        this.grabber.setUserStat(userid, 'likes', likestats);
        
        for (let sharer of this.grabber.getSongMeta(hash, 'sharedBy')) {
            
            let losstats = this.grabber.getUserStat(sharer, 'likesonshares');
            if (!losstats) losstats = {};
            if (!losstats[likeability]) losstats[likeability] = 0;
            losstats[likeability] += 1;
            this.grabber.setUserStat(sharer, 'likesonshares', losstats);
            
        }
        
        //Actually update likeabilities of song
        likmap[userid] = likeability;        
        return this.grabber.setSongMeta(hash, "like", likmap);
    }


    unsetSongLikeability(hash, userid) {
        this.log('Removing ' + userid + ' likeability of ' + hash);

        let likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap || !likmap[userid]) return true;

        let likeability = likmap[userid];

        //Remove old likeability from songrank index
        this._index[userid][likeability] = this._index[userid][likeability].filter((item) => item != hash);

        //Statistics

        let likestats = this.grabber.getUserStat(userid, 'likes');
        if (likestats && likestats[likeability]) {
            likestats[likeability] -= 1;
            this.grabber.setUserStat(userid, 'likes', likestats);
        }

        for (let sharer of this.grabber.getSongMeta(hash, 'sharedBy')) {

            let losstats = this.grabber.getUserStat(sharer, 'likesonshares');
            if (losstats && losstats[likeability]) {
                losstats[likeability] -= 1;
                this.grabber.setUserStat(sharer, 'likesonshares', losstats);
            }

        }

        //Actually delete likeability of song
        delete likmap[userid];
        return this.grabber.setSongMeta(hash, "like", likmap);
    }
    
    
    getSongLikeability(hash, userid) {
        let likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return null;
        return likmap[userid];
    }


    getAllSongLikes(hash) {
        let likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return {};
        return Object.assign({}, likmap);
    }
    
    
    computeSongRank(hash, users, full) {  //users is a list of Discord userids
        let likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return (full ? {users: [], rank: null} : null);
        if (!users) {
            users = Object.keys(likmap);
        }
        
        let i = 0; 
        let acc = 0;
        for (let userid of users) {
            let scale = 1.0;
            let likeability = (likmap[userid] || 0);
            
            let elength = 0, clength = 0;
            if (likeability == -2) {
                if (this._index[userid][-2]) elength = this._index[userid][-2].length;
                if (this._index[userid][-1]) clength = this._index[userid][-1].length;
            }
            if (likeability == 2) {
                if (this._index[userid][2]) elength = this._index[userid][2].length;
                if (this._index[userid][1]) clength = this._index[userid][1].length;
            }
            if (elength && elength > clength * this.param('scaleExtremists')) {
                scale = clength * this.param('scaleExtremists') / elength;
            }
            
            if (likeability > 0) likeability = (likeability - 1) * scale + 1;
            if (likeability < 0) likeability = (likeability + 1) * scale - 1;
        
            acc += likeability;
            i += 1;
        }
        
        if (!i) return (full ? {users: users, rank: null} : null);
        return (full ? {users: users, rank: acc} : acc);
    }


    get likeabilityIcons() {
        return Object.assign({}, LIKEABILITY_ICONS);
    }
    
    
}


module.exports = ModSongRanking;
