/* Module: DictionaryGame -- Play a game for guessing translations of dictionary entries. */

const Module = require('./Module.js');
const sqlite3 = require('sqlite3');
const random = require('meteor-random');
const moment = require('moment');
const diff = require('diff');

try {
    var gd = require('node-gd');
    var discord = require('discord.js');
} catch (err) {}

const PERM_ADMIN = 'administrator';
const PERM_MODERATOR = 'moderator';

const MODE_NORMAL = 'normal';
const MODE_INVERTED = 'inverted';
const MODE_BOTH = 'both';
const MODES = [MODE_NORMAL, MODE_INVERTED, MODE_BOTH];

const PLAYING_PLAYER = 'player';
const PLAYING_CHANNEL = 'channel';

const DELAY_START = 5;
const DELAY_LATEREPLY = 2;
const TIMEOUT_MIN = 3;
const TIMEOUT_MAX = 60;

const FANCY_FONT = "meiryo.ttc";


class ModDictionaryGame extends Module {


    get requiredParams() { return [
        'env',                  //Name of the environment to be used
        'channels'              //List of the IDs of the channels where playing is allowed (note: private message is always allowed)
    ]; }

    get optionalParams() { return [
        'datafile',             //Name of the SQLite database file
        'permissionAdmin',      //Admin permission (can mass-delete dictionaries)
        'permissionModerator',  //Moderator permission (can manipulate dictionaries they don't own)
        'pageSize',             //Amount of results to show at a time when listing dictionary contents
        'playCount',            //Default amount of questions in a game
        'playTimeout',          //Default timeout for answers (s)
        'almost',               //How close to the right answer a wrong answer must be to count as 'almost' ]0..1]
        'maxConsecSkips'        //How many unanswered questions before the game shuts down
    ]; }

    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('DictionaryGame', name);
        
        this._params['datafile'] = 'dictionary.db';
        this._params['permissionAdmin'] = PERM_ADMIN;
        this._params['permissionModerator'] = PERM_MODERATOR;
        this._params['pageSize'] = 10;
        this._params['playCount'] = 20;
        this._params['playTimeout'] = 15;
        this._params['almost'] = 0.75;
        this._params['maxConsecSkips'] = 5;

        this._db = null;

        //It will be null if no game is running or PLAYER_* representing the game type.
        this._playing = null;

        //Gameplay timer
        this._timer = null;
        this._timerLength = 0;

        //Dictionary mode for ongoing game(MODE_*)
        this._mode = null;

        //Amount of words asked so far and maximum amount before the game automatically ends
        this._count = 0;
        this._maxCount = null;
        this._consecSkips = 0;

        //ID of the player running the ongoing game and ID of the environment channel where the game is running
        this._player = null;
        this._channelid = null;

        //Words being used in an ongoing game (dictionary entries)
        this._words = [];

        //Current and previous words (dictionary entries) during a game
        this._current = {};
        this._previous = {};
        this._wordStart = 0;

        //Stats for the ongoing game: {playerid: {right: #, almost: #, wrong: #}, ...}
        this._stats = {};
        this._missed = 0;
    }


    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let testIsModerator = (envname, userid, channelid) =>
        this.mod('Users').testPermissions(envname, userid, channelid, [
            this.param('permissionModerator'), this.param('permissionAdmin')]);


        this.connectDb()
            .then((db) => this._db = db)
            .catch((reason) => this.log('error', "Could not initialize database connection: " + reason));

        if (!opt.envs[this.param('env')]) {
            this.log('error', "Environment not found.");
            return false;
        }


        //Register callbacks


        opt.envs[this.param('env')].on('message', this.onMessage, this);

        
        this.mod('Commands').registerRootDetails(this, 'dg', {
            description: "Manipulate dictionaries and the dictionary game.",
            details: [
                "For the subcommands that take a dictionary name or list of dictionaries, use this format:",
                "  USERNAME|LANGUAGE:CATEGORY",
                "The username or ID of a user can be ommitted and your own will be assumed. Use * for all users.",
                "The language must always be provided. It can only contain the characters a-z and dash (-).",
                "The category can sometimes be ommitted or replaced by * to signify all categories."
            ]
        });
        
        
        this.mod('Commands').registerCommand(this, 'dg add', {
            description: "Adds one or more translations to one of your dictionaries.",
            details: [
                "Each translation should be in the format: WORD=TRANSLATED (no spaces within the translation).",
                "The dictionary will be created if it doesn't exist.",
                "Moderators can add translations to any dictionary."
            ],
            args: ["dictionary", "words", true],
            minArgs: 2
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let dictmap = this.dictionaryNameToMap(args.dictionary, env);

            if (!dictmap || !dictmap.language) {
                ep.reply('Your dictionary reference must contain a language.');
                return true;
            }

            if (!dictmap.category) {
                ep.reply('This command must target a specific category.');
                return true;
            }

            if (dictmap.userid === undefined) {
                dictmap.userid = userid;
            } else if (!dictmap.userid) {
                ep.reply('This command must target a specific user.');
            } else if (dictmap.userid != userid && !testIsModerator(env.name, userid, channelid)) {
                ep.reply('Only moderators can add to other people\'s dictionaries.');
                return true;
            }

            let maps = [];

            for (let word of args.words) {
                let map = this.translationNameToMap(word);
                if (!map || !map.right) continue;
                Object.assign(map, dictmap);
                maps.push(map);
            }

            this.addToDictionary(env.name, maps)
                .then((results) => {
                    ep.reply('Dictionary updated: Added ' + results + ' word' + (results != 1 ? 's' : '') + '.');
                })
                .catch((reason) => {
                    ep.reply('Your words could not be added to the dictionary: ' + reason);
                });

            return true;
        });


        this.mod('Commands').registerCommand(this, 'dg remove', {
            description: "Removes one or more translations from one of your dictionaries.",
            details: [
                "List only the left-hand-side words to be removed from the dictionary.",
                "Moderators can remove translations from any dictionary."
            ],
            args: ["dictionary", "words", true],
            minArgs: 2
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let dictmap = this.dictionaryNameToMap(args.dictionary, env);

            if (!dictmap || !dictmap.language) {
                ep.reply('Your dictionary reference must contain a language.');
                return true;
            }

            if (dictmap.userid === undefined) {
                dictmap.userid = userid;
            } else if (!dictmap.userid) {
                ep.reply('This command must target a specific user.');
            } else if (dictmap.userid != userid && !testIsModerator(env.name, userid, channelid)) {
                ep.reply('Only moderators can remove from other people\'s dictionaries.');
                return true;
            }

            let maps = [];

            for (let word of args.words) {
                let map = this.translationNameToMap(word);
                if (!map) continue;
                Object.assign(map, dictmap);
                maps.push(map);
            }

            this.removeFromDictionary(env.name, maps)
                .then((results) => {
                    if (results) {
                        ep.reply('Dictionary updated: Removed ' + results + ' word' + (results != 1 ? 's' : '') + '.');
                    } else {
                        ep.reply('Nothing to remove.');
                    }
                })
                .catch((reason) => {
                    ep.reply('One or more of your words could not be removed from the dictionary: ' + reason);
                });

            return true;
        });


        this.mod('Commands').registerCommand(this, 'dg delete', {
            description: "Deletes a dictionary or category. All translations in it will be lost.",
            args: ["dictionary"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let dictmap = this.dictionaryNameToMap(args.dictionary, env);

            if (!dictmap || !dictmap.language) {
                ep.reply('Your dictionary reference must contain a language.');
                return true;
            }

            let isAdmin = this.mod('Users').testPermissions(env.name, userid, channelid, [this.param('permissionAdmin')]);

            if (dictmap.userid === undefined) {
                dictmap.userid = userid;
            }
            if (dictmap.userid != userid && !isAdmin) {
                ep.reply('Only admins can delete other people\'s dictionaries.');
                return true;
            }

            if (!dictmap.category && !isAdmin) {
                ep.reply('You must specify a category to delete.');
                return true;
            }

            this.removeFromDictionary(env.name, [dictmap])
                .then((results) => {
                    if (results) {
                        ep.reply('Dictionary updated: Removed ' + results + ' word' + (results != 1 ? 's' : '') + '.');
                    } else {
                        ep.reply('Nothing to remove.');
                    }
                })
                .catch((reason) => {
                    ep.reply('One or more of your words could not be removed from the dictionary: ' + reason);
                });

            return true;
        });


        this.mod('Commands').registerCommand(this, 'dg list', {
            description: "Lists existing dictionaries matching the given optional pattern.",
            details: [
                "By default, all of your dictionaries will be listed. Use *|* to show all dictionaries."
            ],
            args: ["dictionary", "page"],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let dictmap = this.dictionaryNameToMap(args.dictionary, env);
            if (!dictmap) dictmap = {userid: undefined, language: null, category: null};
            if (dictmap.userid === undefined) {
                dictmap.userid = userid;
            }

            let page = (args.page || 1);
            let pageStart = (page - 1) * this.param('pageSize');

            this.dictionaryList(env.name, dictmap)
                .then((results) => {
                    if (!results.length || pageStart >= results.length) {
                        ep.reply("Nothing to show.");
                    } else {
                        let pageEnd = Math.min(results.length - 1, pageStart + this.param('pageSize'));
                        ep.reply("Search for **" + this.escapeNormalizedFormatting(this.dictionaryMapToName(dictmap, env)) + "**: "
                            + (pageStart + 1) + " to " + (pageEnd + 1));
                        for (let i = pageStart; i < results.length && i <= pageEnd; i++) {
                            ep.reply("  " + this.dictionaryMapToName(results[i], env, userid));
                        }
                    }
                })
                .catch((reason) => {
                    ep.reply('Failed to retrieve dictionary list: ' + reason);
                });

            return true;
        });


        this.mod('Commands').registerCommand(this, 'dg show', {
            description: "Shows all translations in a given dictionary.",
            args: ["dictionary", "page"],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this._playing) {
                ep.reply("This command can't be used during a game.");
                return true;
            }

            let dictmap = this.dictionaryNameToMap(args.dictionary, env);
            if (!dictmap || !dictmap.language) {
                ep.reply('Your dictionary reference must contain a language.');
                return true;
            }
            if (dictmap.userid === undefined) {
                dictmap.userid = userid;
            }

            let page = (args.page || 1);
            let pageStart = (page - 1) * this.param('pageSize');

            this.dictionaryContents(env.name, dictmap)
                .then((results) => {
                    if (!results.length || pageStart >= results.length) {
                        ep.reply("Nothing to show.");
                    } else {
                        let pageEnd = Math.min(results.length - 1, pageStart + this.param('pageSize'));
                        ep.reply("Contents of **" + this.escapeNormalizedFormatting(this.dictionaryMapToName(dictmap, env)) + "**: "
                            + (pageStart + 1) + " to " + (pageEnd + 1));
                        for (let i = pageStart; i < results.length && i <= pageEnd; i++) {
                            ep.reply("  *" + results[i].left + "* = " + results[i].right);
                        }
                    }
                })
                .catch((reason) => {
                    ep.reply('Failed to retrieve dictionary contents: ' + reason);
                });

            return true;
        });


        this.mod('Commands').registerCommand(this, 'dg play', {
            description: "Starts a new game.",
            details: [
                "You can list dictionaries to include in the game. By default, all your dictionaries will be included.",
                "The following settings can also be provided as arguments:",
                "  count=NUMBER : The amount of questions before the game automatically ends.",
                "  timeout=NUMBER : Lower the amount of seconds you have to give your answer.",
                "  mode=" + MODES.join("|") + " : Ask for backwards translations or pick a random direction each time [normal].",
                "See also: dg contest"
            ],
            args: ["dictionary", true],
            minArgs: 0
        }, this.prepareGame(PLAYING_PLAYER));


        this.mod('Commands').registerCommand(this, 'dg contest', {
            description: "Starts a new game for everyone in the channel.",
            details: [
                "This command takes the same arguments as dg play ."
            ],
            args: ["dictionary", true],
            minArgs: 0,
            types: ["regular"]
        }, this.prepareGame(PLAYING_CHANNEL));


        this.mod('Commands').registerCommand(this, 'dg end', {
            description: "Ends an ongoing game immediately."
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            if (env.name != this.param('env')) return true;

            if (!this._playing) {
                ep.reply("There is no ongoing game.");
                return true;
            }

            if (this._player != userid && !testIsModerator(env.name, userid, channelid)) {
                ep.reply("Only moderators can stop other people's games.");
                return true;
            }

            if (this._current) {
                //Current question goes unanswered
                this._count -= 1;
            }

            this.stopGame();

            return true;
        });
        

        return true;
    };
    
    
    // # Module code below this line #
    

    //Database manipulation


    connectDb() {
        return new Promise((resolve, reject) => {
            let db = new sqlite3.Database(this.dataPath() + this._params['datafile'],
                sqlite3.OPEN_READWRITE,
                (err) => {
                    if (err) {
                        if (err.code == 'SQLITE_CANTOPEN') {
                            this.prepareDb()
                                .then((db) => resolve(db))
                                .catch(() => reject());
                        } else {
                            this.log('error', 'SQLite error when loading database: ' + err.code);
                            reject();
                        }
                    } else {
                        resolve(db);
                    }
                }
            );
        });
    }


    prepareDb() {
        return new Promise((resolve, reject) => {
            let db = new sqlite3.Database(
                this.dataPath() + this._params['datafile'],
                sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
                (err) => {
                    if (err) {
                        this.log('error', 'SQLite error when creating database: ' + err.code);
                        reject();
                        return;
                    }
                    db.run(`
                        CREATE TABLE dictionary (
                            envname TEXT NOT NULL,
                            userid INTEGER NOT NULL,
                            language TEXT NOT NULL,
                            category TEXT NOT NULL,
                            left TEXT NOT NULL,
                            right TEXT NOT NULL,
                            UNIQUE (envname, userid, language, category, left)
                        )
                    `, (err) => {
                        if (err) {
                            this.log('error', 'SQLite error when creating dictionary table: ' + err.code);
                            reject();
                        } else {
                            resolve(db);
                        }
                    });
                }
            ); 
        });
    }


    addToDictionary(envname, maps) {
        let values = [], params = {};
        for (let i = 0; i < maps.length; i++) {
            values.push(`($envname${i}, $userid${i}, $language${i}, $category${i}, $left${i}, $right${i})`);
            params['$envname' + i] = envname;
            params['$userid' + i] = maps[i].userid;
            params['$language' + i] = maps[i].language;
            params['$category' + i] = maps[i].category;
            params['$left' + i] = maps[i].left;
            params['$right' + i] = maps[i].right;
        }
        return new Promise((resolve, reject) => {
            if (!this._db) reject('Database connection not found.');
            this._db.run(`
                INSERT INTO dictionary (envname, userid, language, category, left, right)
                VALUES ${values.join(', ')}
            `, params, function(err) {
                if (err) {
                    reject('Error when adding to dictionary: ' + err.code);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }


    removeFromDictionary(envname, maps) {
        return new Promise(async function(resolve, reject) {
            let removes = 0;
            try {
                for (let map of maps) {
                    removes += await this.removeSingleFromDictionary(envname, map);
                }
            } catch (reason) {
                reject(reason);
            }
            resolve(removes);
        }.bind(this));
    }


    removeSingleFromDictionary(envname, map) {
        let expr = ['envname = $envname'], params = {'$envname': envname};
        if (map.userid) {
            expr.push('userid = $userid');
            params['$userid'] = map.userid;
        }
        if (map.language) {
            expr.push('language = $language');
            params['$language'] = map.language;
        }
        if (map.category) {
            expr.push('category = $category');
            params['$category'] = map.category;
        }
        if (map.left) {
            expr.push ('left = $left');
            params['$left'] = map.left;
        }
        if (expr.length < 2) {
            reject('No criteria.');
            return;
        }
        expr = expr.join(' AND ');
        return new Promise((resolve, reject) => {
            if (!this._db) reject('Database connection not found.');
            this._db.run('DELETE FROM dictionary WHERE ' + expr, params, function(err) {
                if (err) {
                    reject('Error when removing from dictionary: ' + err.code);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }


    dictionaryList(envname, map) {
        let expr = ['envname = $envname'], params = {'$envname': envname};
        if (map.userid) {
            expr.push('userid = $userid');
            params['$userid'] = map.userid;
        }
        if (map.language) {
            expr.push('language = $language');
            params['$language'] = map.language;
        }
        if (map.category) {
            expr.push('category = $category');
            params['$category'] = map.category;
        }
        expr = expr.join(' AND ');
        return new Promise((resolve, reject) => {
            if (!this._db) reject('Database connection not found.');
            this._db.all(`
                SELECT DISTINCT userid, language, category
                FROM dictionary
                WHERE ${expr}
                ORDER BY userid, language, category
            `, params, (err, rows) => {
                if (err) {
                    reject('Error when reading dictionary list: ' + err.code);
                } else {
                    resolve(rows);
                }
            });
        });
    }


    dictionaryContents(envname, map) {
        let expr = ['envname = $envname'], params = {'$envname': envname};
        if (map.userid) {
            expr.push('userid = $userid');
            params['$userid'] = map.userid;
        }
        if (map.language) {
            expr.push('language = $language');
            params['$language'] = map.language;
        }
        if (map.category) {
            expr.push('category = $category');
            params['$category'] = map.category;
        }
        expr = expr.join(' AND ');
        if (!expr) expr = '1';
        return new Promise((resolve, reject) => {
            if (!this._db) reject('Database connection not found.');
            this._db.all(`
                SELECT DISTINCT left, right
                FROM dictionary
                WHERE ${expr}
                ORDER BY userid, language, category
            `, params, (err, rows) => {
                if (err) {
                    reject('Error when reading dictionary contents: ' + err.code);
                } else {
                    resolve(rows);
                }
            });
        });
    }


    //Parsing
    

    dictionaryMapToName(map, env, myid) {
        //Optionally pass an environment to resolve the userid immediately
        //Optionally pass myid to inhibit that id in the name string
        if (!map) return null;
        
        let name = (map.language || "*");

        if (map.category) name = name + ':' + map.category;

        if (!map.userid) {
            name = '*|' + name;
        } else if (!myid || map.userid != myid) {
            name = (env ? env.idToDisplayName(map.userid) || map.userid : map.userid) + '|' + name;
        }

        return name;
    }


    dictionaryNameToMap(name, env) {
        //Optionally pass an environment to resolve the userid immediately
        if (!name) return null;

        let map = {};
        
        let unmatches = /^(([^|]+)\|)?(.*)$/.exec(name);
        if (unmatches[2]) {
            if (unmatches[2] == "*") map.userid = null;
            else map.userid = (env ? env.displayNameToId(unmatches[2]) || unmatches[2] : unmatches[2]);
        } else {
            map.userid = undefined;
        }

        let langmatches = /^([A-Za-z-]+|\*)(:([^:]+))?$/.exec(unmatches[3]);
        if (langmatches) {
            map.language = (langmatches[1] != "*" ? langmatches[1] : null);
            if (!langmatches[3] || langmatches[3] == "*") {
                map.category = null;
            } else {
                map.category = langmatches[3];
            }
        }

        return map;
    }


    translationMapToName(map) {
        return map.left + (map.right ? '=' + map.right : '');
    }

    
    translationNameToMap(name, map) {
        //Optionally pass a map to add left and right to that map instead of creating a new one
        if (!map) map = {};
        let matches = /^([^=]+)(=([^=]+))?$/.exec(name);
        if (!matches) return null;
        map.left = matches[1].trim();
        if (matches[3]) {
            map.right = matches[3].trim();
        }
        return map;
    }


    //Playing the game


    prepareGame(gametype) {
        //This function will return the dg play/dg contest handler. 
        return function(env, type, userid, channelid, command, args, handle, ep) {

            if (env.name != this.param('env')) return true;

            if (type == "regular" && this.param('channels').length && this.param('channels').indexOf(channelid) < 0) {
                ep.reply("You can't play in this channel.");
                return true;
            }

            if (this._playing) {
                ep.reply("The game is already running.");
                return true;
            }

            //The handler creates and executes an async function. The async function returns a promise, which we ignore.
            //This allows us to use dictionary queries synchronously.
            (async function() {

                let maxCount = this.param("playCount");
                let timeout = this.param("playTimeout");
                let mode = MODE_NORMAL;
                let words = [];

                for (let dictname of args.dictionary) {
                    let matches;

                    matches = /^count=([0-9])+$/i.exec(dictname);
                    if (matches) { maxCount = Math.max(1, Math.min(999, matches[1])); continue; }
                    
                    matches = /^timeout=([0-9]+)$/i.exec(dictname);
                    if (matches) { timeout = Math.max(TIMEOUT_MIN, Math.min(TIMEOUT_MAX, matches[1])); continue; }

                    let regex = new RegExp("mode=(" + MODES.join("|") + ")", "i");
                    matches = regex.exec(dictname);
                    if (matches) { mode = matches[1]; continue; }

                    let dict = this.dictionaryNameToMap(dictname, env);
                    if (!dict) {
                        ep.reply("Invalid dictionary: " + dictname);
                        continue;
                    }

                    try {
                        let contents = await this.dictionaryContents(env.name, dict);
                        if (!contents.length) {
                            ep.reply("Dictionary is empty: " + dictname);
                            continue;
                        }

                        words.push(...contents);
                    } catch (reason) {}
                }

                if (!words.length) {
                    ep.reply("No words to translate, so the game can't begin.");
                    return;
                }

                this._playing = gametype;
                this._timerLength = timeout;
                this._mode = mode;
                this._count = 0;
                this._consecSkips = 0;
                this._maxCount = maxCount;
                this._player = userid;
                this._channelid = channelid;
                this._words = words;
                this._current = {};
                this._previous = {};
                this._stats = {};
                this._missed = 0;

                ep.reply("The game is about to start. Get ready...");
                this._timer = setTimeout(() => this.playWord(), DELAY_START * 1000);

            }).apply(this);

            return true;
        }.bind(this);
    }


    playWord() {
        if (this._maxCount && this._count >= this._maxCount) {
            return this.stopGame();
        }
        this._count += 1;

        //Obtain new word/challenge
        this._previous = this._current;
        if (this._words.length > 1) {
            while (this._previous == this._current) {
                this._current = this._words[Math.floor(random.fraction() * this._words.length)];
                if (this._mode == MODE_BOTH) {
                    this._current.mode = random.fraction() * 2 < 1 ? MODE_NORMAL : MODE_INVERTED;
                } else {
                    this._current.mode = this._mode;
                }
            }
        }

        //Register challenge start time
        this._wordStart = moment().unix();
        
        //Send word to channel
        let env = this.env(this.param('env'));
        let query = (this._current.mode == MODE_INVERTED ? this._current.right : this._current.left);

        if (gd && env.envName == "Discord") {
            //Fancy (png image of rendered font): Requires gd, node-gd and Discord
            let png = this.createPngFromText(query);
            let re = new discord.RichEmbed()
                .attachFile({name: "query.png", attachment: png})
                .setImage("attachment://query.png");
            env.msg(this._channelid, re);
        } else {
            //Plaintext (normal)
            env.msg(this._channelid, env.applyFormatting("**" + this.escapeNormalizedFormatting(query) + "**"));
        }
        
        //Start countdown timer
        this._timer = setTimeout(() => this.endWord(), this._timerLength * 1000);
    }


    charsInCommon(attempt, answer) {
        let changes = diff.diffChars(answer, attempt);
        let common = 0;
        for (let change of changes) {
            if (!change.added && !change.removed) {
                common += change.value.length;
            }
        }
        return common;
    }


    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (env.name != this.param('env')) return false;
        if (!this._playing || this._channelid != channelid) return false;  //Not in a channel with an ongoing game
        if (this._playing == PLAYING_PLAYER && authorid != this._player) return false;  //Not a participant
        if (!this._current) return false;  //Still in preparation time

        this._consecSkips = 0;
        
        //Check how far off whatever the player said is from the desired answer/translation
        let answer = (this._current.mode == MODE_NORMAL ? this._current.right : this._current.left);
        let common = this.charsInCommon(message.trim(), answer);

        if (answer.length == common) {
            //Not off at all - Right answer! Carry on.
            if (!this._stats[authorid]) this._stats[authorid] = {right: 0, almost: 0, wrong: 0};
            this._stats[authorid].right += 1;
            env.msg(channelid, "Correct!");
        } else {
            
            //This mechanism allows people to retry if they were still typing the answer to the previous question.
            let offprev = 0;
            if (this._previous && moment().unix() - this._wordStart < DELAY_LATEREPLY) {
                let answerprev = (this._previous.mode == MODE_NORMAL ? this._previous.right : this._previous.left);
                let commonprev = this.charsInCommon(message.trim(), answerprev);
                offprev = commonprev / answerprev.length;
            }

            let offcurrent = common / answer.length;
            if (offprev > offcurrent) {
                env.msg(channelid, "That's closer to the previous word! Try again.");
                return false;
            }

            if (!this._stats[authorid]) this._stats[authorid] = {right: 0, almost: 0, wrong: 0};

            if (offcurrent > this.param("almost")) {
                //Wrong answer, but close to the right one - count as "almost" and say the right answer.
                this._stats[authorid].almost += 1;
                env.msg(channelid, "Almost! The right answer was " + answer);
            } else {
                //Just plain wrong!
                this._stats[authorid].wrong += 1;
                env.msg(channelid, "WRONG!");
            }

        }

        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        this.playWord();
    }


    endWord() {
        this._timer = null;

        let env = this.env(this.param('env'));
        
        //Timer ran out.
        this._missed += 1;
        env.msg(this._channelid, "Time up!");

        this._consecSkips += 1;
        if (this._consecSkips >= this.param("maxConsecSkips")) {
            env.msg(this._channelid, "No one seems to be here...");
            this.stopGame();
            return;
        }

        this.playWord();
    }


    stopGame() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        let env = this.env(this.param('env'));
        env.msg(this._channelid, "Game ended after " + this._count + " word" + (this._count != 1 ? "s" : "") + ".");

        if (this._count) {
            if (this._playing == PLAYING_PLAYER) {
                if (this._stats[this._player]) {
                    //Display single player stats
                    let stats = this._stats[this._player];
                    env.msg(this._channelid, env.applyFormatting('**Score: __' + (stats.right * 3 + stats.almost) + '__**')
                        + ` [Right: ${stats.right} (${(stats.right / this._count * 100).toFixed(1)}%)`
                        + ` ; Almost: ${stats.almost} (${(stats.almost / this._count * 100).toFixed(1)}%)`
                        + ` ; Wrong: ${stats.wrong} (${(stats.wrong / this._count * 100).toFixed(1)}%)`
                        + ` ; Missed: ${this._missed} (${(this._missed / this._count * 100).toFixed(1)}%)]`);
                }
            } else {
                //Display contest stats
                let sortedStats = [];
                for (let player in this._stats) {
                    let stats = this._stats[player];
                    stats.score = stats.right * 3 + stats.almost;
                    stats.player = player;
                    sortedStats.push(stats);
                }
                sortedStats.sort((a, b) => b.score - a.score);
                env.msg(this._channelid, env.applyFormatting(`**__Results__** (Answered: ${this._count - this._missed}/${this._count})`));
                for (let stats of sortedStats) {
                    env.msg(this._channelid, env.applyFormatting(env.idToDisplayName(stats.player) + ': **' + stats.score + '**')
                        + ` [R: ${stats.right} (${(stats.right / this._count * 100).toFixed(1)}%)`
                        + ` A: ${stats.almost} (${(stats.almost / this._count * 100).toFixed(1)}%)`
                        + ` W: ${stats.wrong} (${(stats.wrong / this._count * 100).toFixed(1)}%)]`);
                }
            }
        }

        this._playing = null;
        this._mode = null;
        this._player = null;
        this._channelid = null;
    }


    //Auxiliary


    createPngFromText(text, size, color) {
        if (!size) size = 32;  //pt
        if (!color) color = [0, 0, 0];  //R, G, B in decimal integers
        let img = gd.createTrueColorSync(1, 1);
        let bb = img.stringFTBBox(gd.trueColorAlpha(255, 255, 255, 127), __dirname + '/' + FANCY_FONT, size, 0, 0, 0, text);
        let w = Math.abs(bb[4] - bb[0]) + 4, h = Math.abs(bb[5] - bb[1]) + 4;
        img.destroy();
        img = gd.createTrueColorSync(w, h);
        img.alphaBlending(0);
        img.saveAlpha(1);
        img.filledRectangle(0, 0, w, h, gd.trueColorAlpha(255, 255, 255, 127));
        img.stringFT(gd.trueColorAlpha(color[0], color[1], color[2], 0), __dirname + '/' + FANCY_FONT, size, 0, -1 * bb[6] + 2, -1 * bb[7] + 2, text);
        let ptr = Buffer.from(img.pngPtr(), "binary");
        img.destroy();
        return ptr;
    }

}


module.exports = ModDictionaryGame;
