/* Module: VRChat -- Show information about VRChat users on Discord. */

const moment = require('moment');
const random = require('meteor-random');
const { MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const WebSocket = require('ws');

const Module = require('../Module.js');
const { enableConsole } = require('../Logger.js');

const PERM_ADMIN = 'administrator';

const ENDPOINT = "https://api.vrchat.cloud/api/1/";
const NO_AUTH = ["config", "time", "visits"];
const WEBSOCKET = "wss://pipeline.vrchat.cloud/";
const HTTP_USER_AGENT = "Protected/Rowboat";
const RATE_DELAY = 1000;

const STATUS_ONLINE = ["active", "join me", "ask me"];
const TRUST_PRECEDENCE = ["system_trust_veteran", "system_trust_trusted", "system_trust_known", "system_trust_basic"];

const ZWSP = "​";  //Zero-width space (\u200b)
const TRUST_CHANGE_ICON = "👉";
const CLOCKS = ["🕛","🕧","🕐","🕜","🕑","🕝","🕒","🕞","🕓","🕟","🕔","🕠","🕕","🕡","🕖","🕢","🕗","🕣","🕘","🕤","🕙","🕥","🕚","🕦"];

const MAX_FIELDLEN = 1024;

/*
Object.defineProperty(global, '__stack', {
get: function() {
        var orig = Error.prepareStackTrace;
        Error.prepareStackTrace = function(_, stack) {
            return stack;
        };
        var err = new Error;
        Error.captureStackTrace(err, arguments.callee);
        var stack = err.stack;
        Error.prepareStackTrace = orig;
        return stack;
    }
});
    
Object.defineProperty(global, '__line', {
get: function() {
        return __stack[2].getLineNumber();
    }
});

Object.defineProperty(global, '__function', {
get: function() {
        return __stack[2].getFunctionName();
    }
});
*/

class ModVRChat extends Module {

    get requiredParams() { return [
        "env",
        "username",             //VRChat username
        "password",             //VRChat password
    ]; }
    
    get optionalParams() { return [
        "updatefreq",           //How often to run the main update function (s)
        "usewebsocket",         //Whether to connect to the VRChat websocket to receive faster updates
        "localaddress",         //IP address of a local network interface
        "friendliststale",      //How long before the entire friend list should be refreshed by the update function (s)
        "bakestale",            //How long a baked status embed remains fresh and shouldn't be updated (s)
        "statuschan",           //ID of text channel for baked person status embeds
        "knownrole",            //ID of a role that will be automatically assigned to known people and unassigned from unknown people
        "offlinetolerance",     //How long to delay offline announcements to improve odds they're real and not slow world loading (s)
        
        "worldfreq",            //How often to run the world update function (s) [Note: Worlds can be updated outside this function.]
        "worldchan",            //ID of text channel for worlds (warning: all contents will be deleted)
        "worldstale",           //How long after retrieval until an entry in the world cache goes stale (s)
        "worldexpiration",      //How long after emptying until an entry in the world cache is removed (h)
        "staleupdatesperitr",   //How many stale worlds are updated per every time the update function runs
        "instancechan",         //ID of text channel for baked instance members embeds

        "coloroffline",         //Color for "offline"/"unused" embed accents
        "coloronline",          //Color for "online"/"used" embed accents
        
        "pinnedchan",           //ID of text channel for pinned worlds
        "pinnedwebhook",        //Whether to use a webhook for pinned worlds (simulate requester)

        "announcechan",         //ID of text channel for announcements
        "useannstacks",         //Whether to use announcement stacks (for online/offline announcements)
        "anncollapse",          //How long since the latest announcement to collapse announcements (s)
        "anncollapseconsec",    //How long since the latest announcement to collapse announcements if it's the latest message too (s)
        "anncollapsetrans",     //Maximum interval for collapsing a user's state transition (s)
        "annremovetransmin",    //Maximum interval for removing instead of collapsing a reconnect/peek (s)
        "annmaxstack",          //Maximum amount of names to list in a collapsed announcement

        "expiration",           //How long to stay unfriended before unassigning a person (h)
        "absence",              //How long can a known user stay offline before they're automatically unassigned (d)
        "inactivity",           //How long can a known user not talk on Discord before they're automatically unassigned (d)

        "ddelay",               //Delay between actions in the delayed action queue (ms) [used to prevent rate limiting]

        "pinnedemoji",          //Emoji used for pinning worlds
        "inviteemoji",          //Emoji used for requesting an invitation
        "anyemoji",             //Emoji that represents any visible instance
        "publicemoji",          //Emoji that represents a public instance
        "friendsplusemoji",     //Emoji that represents a friends+ instance ["hidden"]
        "friendsemoji",         //Emoji that represents a friends instance
        "deleteemoji",          //Emoji for deleting things

        "alertmin",             //Minimum amount of online people to vrcalert at
        "alertcooldown",        //How long until a user can be alerted again (mins)

        "statedebug"            //Log inbound state and location changes
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    get denv() {
        return this.env(this.param('env'));
    }

    get statuschan() {
        return this.denv.server.channels.cache.get(this.param("statuschan"));
    }

    get announcechan() {
        return this.denv.server.channels.cache.get(this.param("announcechan"));
    }

    get worldchan() {
        return this.denv.server.channels.cache.get(this.param("worldchan"));
    }

    get instancechan() {
        return this.denv.server.channels.cache.get(this.param("instancechan"));
    }

    get pinnedchan() {
        return this.denv.server.channels.cache.get(this.param("pinnedchan"));
    }


    constructor(name) {
        super('VRChat', name);
     
        this._params["updatefreq"] = 180;
        this._params["usewebsocket"] = true;
        this._params["localaddress"] = undefined;
        this._params["friendliststale"] = 179;
        this._params["bakestale"] = 29;

        this._params["offlinetolerance"] = 119;

        this._params["worldfreq"] = 300;
        this._params["worldstale"] = 3600;
        this._params["worldexpiration"] = 25;
        this._params["staleupdatesperitr"] = 10;
        
        this._params["coloroffline"] = [200, 200, 200];
        this._params["coloronline"] = [40, 255, 40];

        this._params["pinnedwebhook"] = true;

        this._params["useannstacks"] = true;
        this._params["anncollapse"] = 600;
        this._params["anncollapseconsec"] = 1200;
        this._params["anncollapsetrans"] = 600;
        this._params["annremovetransmin"] = 45;
        this._params["annmaxstack"] = 10;

        this._params["expiration"] = 48;
        this._params["absence"] = 32;
        this._params["inactivity"] = 62;

        this._params["ddelay"] = 250;

        this._params["pinnedemoji"] = "📌";
        this._params["inviteemoji"] = "✉️";
        this._params["anyemoji"] = "🚪";
        this._params["publicemoji"] = "🌍";
        this._params["friendsplusemoji"] = "🥳";
        this._params["friendsemoji"] = "🧑‍🤝‍🧑";
        this._params["deleteemoji"] = "❌";

        this._params["alertmin"] = 4;
        this._params["alertcooldown"] = 60;

        this._params["statedebug"] = false;

        this._people = null;  //{USERID: {see registerPerson}, ...}
        this._worlds = null;  //The worlds cache {WORLDID: {..., see getWorld}, ...}
        this._misc = null;  //Dynamic settings

        this._friends = null;  //The transient status cache {updated, VRCUSERID: {...}, ...}
        this._frupdated = null;

        this._sneaks = {};  //Users who were sneaking when they last went offline {USERID: TS, ...}
        this._invisibles = {};  //Users who were invisible when they last went offline {USERID: TS, ...}

        this._config = null;  //The full object returned by the "config" API. This API must be called before any other request.
        this._auth = null;  //The auth cookie
        this._me = null;  //The bot user data
        this._ws = null;  //The websocket
        this._wstimeout = null;  //The websocket's ping timer
        this._wsping = 0;  //Pending pings

        this._pins = {};  //Map of pinned worlds (transient) {WORLDID: Message_in_pinnedchan, ...}

        this._lt_online = {prefix: "🟢 Online", msg: null, ts: null, stack: []};  //State of recent 'is online' announcements
        this._lt_offline = {prefix: "⚪ Offline", msg: null, ts: null, stack: []};  //State of recent 'is offline' announcements
        this._lt_reconnect = {prefix: "🟣 Reconnect", msg: null, ts: null, stack: []};  //State of recent 'reconnect' announcements
        this._lt_quickpeek = {prefix: "⚫ Quick peek", msg: null, ts: null, stack: []};  //State of recent 'quick peek' announcements

        this._ready = false;  //Whether we're done caching existing status messages and can start baking new ones.
        this._modTime = null;  //A reference to the Time module, if available.
        this._modReactionRoles = null;  //A reference to the ReactionRoles module, if available.

        this._timer = null;  //Main timer
        this._qtimer = null;  //Quick timer - Used in websocket mode only
        this._wtimer = null;  //World timer - Updates the world cache

        this._dqueue = [];  //Discord update queue
        this._dtimer = null;  //Discord update queue timer

        this._lastAnnounceMessageId = null;  //Id of the last message in the announce channel
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        opt.moduleRequest('Time', (time) => { this._modTime = time; });
        opt.moduleRequest('ReactionRoles', (reactionRoles) => { this._modReactionRoles = reactionRoles; });
        
        let modActivity = null;
        opt.moduleRequest('Activity', (activity) => { modActivity = activity; });

        
        //# Load data

        this._people = this.loadData(undefined, undefined, {quiet: true});
        if (this._people === false) return false;

        this._worlds = this.loadData(this.name.toLowerCase() + ".worlds.json", {}, {quiet: true});

        this._misc = this.loadData(this.name.toLowerCase() + ".misc.json", {
            pronounscolor: null,
            statusrolegroups: []
        }, {quiet: true});

        this.resetAllPersons();


        //# Cleanup handler

        opt.pushCleanupHandler((next) => {
            if (this._auth) {
                this.vrcpost("logout", null, "PUT")
                    .then(() => {
                        this.log("Logged out from VRChat.");
                    })
                    .catch((e) => {
                        this.log("error", "Unable to log out from VRChat.");
                    })
                    .finally(() => {
                        this.emptyWorlds();
                        this.dqueue(next);
                    });
            } else {
                this.emptyWorlds();
                this.dqueue(next);
            }
        });

        
        //# Register Discord callbacks


        let guildMemberRemoveHandler = async (member) => {

            //Unlearn departing person

            let person = this.getPerson(member.id);
            if (person && this.statuschan && person.msg) {
                try {
                    let message = await this.statuschan.messages.fetch(person.msg);
                    if (message) message.delete();
                } catch (e) {}
            }

            this.unregisterPerson(member.id);
            if (person) {
                this.vrcUnfriend(person.vrc);
            }

        };


        let messageDeleteHandler = (message) => {
        
            //Clear deleted message references

            for (let userid in this._people) {
                let person = this.getPerson(userid);
                if (person.msg == message.id) {
                   this.clearPersonMsg(userid);
                   break; 
                }
            }

            for (let worldid in this._worlds) {
                let world = this.getCachedWorld(worldid);
                if (world.msg == message.id) {
                    this.clearWorldMsg(worldid);
                    break;
                }
            }

            for (let worldid in this._pins) {
                if (this._pins[worldid].id == message.id) {
                    delete this._pins[worldid];
                }
            }

            let ids = this.findInstanceByMsg(message.id);
            if (ids) {
                this.clearInstance(ids[0], ids[1]);
            }
            
        };


        let voiceStateUpdateHandler = (oldState, state) => {

            this.setLatestDiscord(state.member?.id);

        };


        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.me.id) return;

            let channelid = messageReaction.message.channel.id;

            //Delete favorites
            if (this.pinnedchan && channelid == this.pinnedchan.id) {

                if (messageReaction.emoji.name == this.param("deleteemoji")) {
                    let owners = this.extractOwnersFromPin(messageReaction.message);
                    if (owners && owners.find(owner => owner == user.id)) {
                        messageReaction.message.delete();
                    } else {
                        messageReaction.users.remove(user.id);
                    }
                }

            }

            //Regular (keep at the end)
            if ((!this.statuschan || channelid != this.statuschan.id)
                    && (!this.worldchan || channelid != this.worldchan.id)
                    && (!this.pinnedchan || channelid != this.pinnedchan.id)) {
                this.setLatestDiscord(user.id);
            }

        };


        let buttonHandler = async (buttonInteraction) => {

            let channelid = buttonInteraction.message.channel.id;

            if (buttonInteraction.customId == "pin") {
                //Pin worlds to favorites channel

                if (this.worldchan && channelid == this.worldchan.id && this.pinnedchan) {

                    this.potentialWorldPin(buttonInteraction.message, false, buttonInteraction.user.id)
                        .then(result => {
                            if (result) {
                                buttonInteraction.update({components: [this.worldInviteButtons(true)]});
                            }
                        });
                    this.setLatestDiscord(buttonInteraction.user.id);
    
                }
                
            }

            if (buttonInteraction.customId.match(/^invite/)) {
                //Invite to world instances

                if (this.worldchan && channelid == this.worldchan.id || this.pinnedchan && channelid == this.pinnedchan.id) {
                    
                    let worldid = this.extractWorldFromMessage(buttonInteraction.message);
                    let person = this.getPerson(buttonInteraction.user.id);

                    if (person && person.vrc && worldid) {

                        buttonInteraction.deferReply({ephemeral: true});
                        
                        let region = this.idealServerRegion(buttonInteraction.user.id);

                        if (buttonInteraction.customId == "invitepublic" || buttonInteraction.customId == "inviteany") {
                            this.getWorld(worldid, true)
                                .then((world) => {
                                    if (!world) throw {};
                                    let instances = Object.values(world.instances).filter(ci => !ci.members || Object.keys(ci.members).length < world.capacity).map(ci => ci.instance);
                                    let instance;
                                    if (buttonInteraction.customId == "inviteany") {
                                        instance = this.generateInstanceFor(person.vrc, "public", instances, undefined, region);
                                    } else {
                                        instance = this.generateInstanceFor(person.vrc, "public", null, instances.map(ci => ci.split("~")[0]), region);
                                    }
                                    this.vrcInvite(person.vrc, worldid, instance)
                                        .then(() => { buttonInteraction.editReply("Invite sent."); })
                                        .catch(e => {
                                            this.log("error", "Failed to invite " + buttonInteraction.user.id + " to " + worldid + " instance " + instance + ": " + JSON.stringify(e));
                                            buttonInteraction.deleteReply();
                                        });
                                })
                                .catch((e) => {
                                    this.log("warn", "Failed to invite " + buttonInteraction.user.id + " to " + worldid + " because the world couldn't be retrieved.");
                                    buttonInteraction.deleteReply();
                                });
                        } else {
                            let instance = this.generateInstanceFor(this._me.id, buttonInteraction.customId == "invitefriendsplus" ? "friends+" : "friends", undefined, undefined, region);
                            this.vrcInvite(person.vrc, worldid, instance)
                                .then(() => { buttonInteraction.editReply("Invite sent."); })
                                .catch(e => {
                                    this.log("error", "Failed to invite " + buttonInteraction.user.id + " to " + worldid + " instance " + instance + ": " + JSON.stringify(e));
                                    buttonInteraction.deleteReply();
                                });
                        }

                    }

                }
                
            }

            if (buttonInteraction.customId == "join") {
                
                //Obtain public/friends location invite by reacting to user with inviteemoji
                if (this.statuschan && channelid == this.statuschan.id) {

                    buttonInteraction.deferReply({ephemeral: true});

                    let targetid = this.findPersonByMsg(buttonInteraction.message.id);
                    if (targetid) {

                        let target = this.getPerson(targetid);
                        let person = this.getPerson(buttonInteraction.user.id);
                        if (person && person.vrc && target.latestlocation && !target.sneak && !target.invisible) {
                            this.vrcInvite(person.vrc, this.worldFromLocation(target.latestlocation), this.instanceFromLocation(target.latestlocation))
                                .then(() => { buttonInteraction.editReply("Invite sent."); })
                                .catch(e => {
                                    this.log("error", "Failed to invite " + user.id + " to " + target.latestlocation + ": " + JSON.stringify(e))
                                    buttonInteraction.deleteReply();
                                });
                        } else {
                            buttonInteraction.deleteReply();
                        }
                    } else {
                        buttonInteraction.deleteReply();
                    }

                }

                //Obtain instance location invite by reacting with inviteemoji
                if (this.instancechan && channelid == this.instancechan.id) {

                    buttonInteraction.deferReply({ephemeral: true});

                    let ids = this.findInstanceByMsg(buttonInteraction.message.id);
                    if (ids) {
                        let world = this.getCachedWorld(ids[0]);
                        let person = this.getPerson(buttonInteraction.user.id);
                        if (person && person.vrc) {
                            this.vrcInvite(person.vrc, ids[0], world.instances[ids[1]].instance)
                                .then(() => { buttonInteraction.editReply("Invite sent."); })
                                .catch(e => {
                                    this.log("error", "Failed to invite " + user.id + " to " + ids[0] + ":" + ids[1] + ": " + JSON.stringify(e))
                                    buttonInteraction.deleteReply();
                                });
                        } else {
                            buttonInteraction.deleteReply();
                        }
                    } else {
                        buttonInteraction.deleteReply();
                    }

                }

            }

        };

        let interactionCreateHandler = (interaction) => {
            if (interaction.isButton()) return buttonHandler(interaction);
        };


        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (env.name != this.param("env") || type != "regular" || messageObject.webhookId) return;

            this.setLatestDiscord(authorid);

            if (channelid == this.announcechan?.id) {
                this._lastAnnounceMessageId = messageObject.id;
            }

            if (channelid == this.pinnedchan?.id) {
                //Direct sharing to pinnedchan
                let worldids = this.extractWorldsFromText(message);
                messageObject.delete();

                if (!worldids.length) {
                    this.announce("> " + message.split("\n")[0] + "\n<@" + authorid + "> The <#" + channelid + "> channel is for pinned worlds only!");
                    return true;
                }

                for (let worldid of worldids) {
                    if (this._pins[worldid]) {
                        let worldname = this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("<@" + authorid + "> The world " + worldname + " is already pinned.");
                        return true;
                    }

                    this.dqueue(function() {
                        this.potentialWorldPin(worldid, true, authorid)
                            .then(result => {
                                if (!result) {
                                    let worldname = this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("<@" + authorid + "> Failed to pin the world " + worldname + " - does it still exist?");
                                }
                            });
                    }.bind(this));
                }

                return true;
            }
        };

        
        this.denv.on("connected", async () => {

            let cachePromises = [];

            for (let userid in this._people) {
                let person = this.getPerson(userid);

                let member = this.denv.server.members.cache.get(userid);
                
                if (member) {

                    //Prefetch person status messages

                    if (this.statuschan && person.msg) {
                        try {
                            cachePromises.push(this.statuschan.messages.fetch(person.msg));
                        } catch (e) {}
                    }

                } else {

                    //Unlearn missing persons

                    if (this.statuschan && person.msg) {
                        this.dqueue(function() {
                            this.statuschan.messages.fetch(person.msg)
                                .then(message => message.delete())
                                .catch((e) => { this.log("warn", "Failed to delete departed user's message: " + JSON.stringify(e)); });
                        }.bind(this));
                    }

                    this.unregisterPerson(userid);

                }
            }

            Promise.all(cachePromises).then(() => { this._ready = true; });

            if (this.worldchan) {

                //Prefetch and check world messages

                let index = {};
                for (let worldid in this._worlds) {
                    if (this._worlds[worldid].msg) {
                        index[this._worlds[worldid].msg] = true;
                    }
                }

                this.denv.scanEveryMessage(this.worldchan, (message) => {
                    if (!index[message.id]) {
                        this.dqueue(function() {
                            message.delete();
                        }.bind(this));
                    }
                });

            }

            if (this.pinnedchan) {

                //Prefetch, index and fix favorites

                this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                    let worldid = this.extractWorldFromMessage(message);
                    if (!worldid) return;
                    this._pins[worldid] = message;
                });

            }

            this.denv.client.on("guildMemberRemove", guildMemberRemoveHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
            this.denv.client.on("voiceStateUpdate", voiceStateUpdateHandler);
            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
            this.denv.client.on("interactionCreate", interactionCreateHandler);
            this.denv.on("message", messageHandler);
        });


        //# Set up VRChat session

        let friendStateChangeHandler = (vrcuserid, state, userdata) => {
            let userid = this.getUseridByVrc(vrcuserid);
            let person = this.getPerson(userid);
            if (!person) return;

            if (this.param("statedebug")) {
                this.log("-> StateChange >> " + person.name + " " + state);
            }

            if (!userdata) userdata = {};
            if (userdata.state) delete userdata.state;

            if (state == "active") userdata.status = "website";
            if (state == "offline") { userdata.status = "offline"; userdata.location = "offline"; }
            if (state == "online") userdata.location = "private";
            if (!this._friends[vrcuserid]) this._friends[vrcuserid] = {};
            Object.assign(this._friends[vrcuserid], userdata);

            this.updateStatus(userid, this._friends[vrcuserid].status);

            if (this.statuschan) {
                this.dqueue(function() {
                    this.bakeStatus(userid, this._friends[vrcuserid]);
                }.bind(this));
            }
        }

        let friendLocationChangeHandler = (vrcuserid, userdata, partialworld, instance, location) => {
            let userid = this.getUseridByVrc(vrcuserid);
            let person = this.getPerson(userid);
            if (!person) return;

            if (this.param("statedebug")) {
                this.log("-> LocationChange >> " + person.name + " " + location);
            }

            if (userdata.state) delete userdata.state;

            if (!this._friends[vrcuserid]) this._friends[vrcuserid] = {};
            Object.assign(this._friends[vrcuserid], userdata);
            this._friends[person.vrc].location = location;

            let affectedworlds = {};

            if (person.latestlocation != location) {
                let oldworldid = this.worldFromLocation(person.latestlocation), oldinstanceid = this.instanceIdFromLocation(person.latestlocation);
                if (oldworldid && !person.sneak && !person.invisible) {
                    this.removeWorldMember(oldworldid, userid);
                    if (!affectedworlds[oldworldid]) affectedworlds[oldworldid] = {};
                    affectedworlds[oldworldid][oldinstanceid] = true;
                }
                this.updateLocation(userid, location);
                let worldid = this.worldFromLocation(location), instanceid = this.instanceIdFromLocation(location);
                if (worldid && !person.sneak && !person.invisible) {
                    this.addWorldMember(worldid, location, userid);
                    if (!affectedworlds[worldid]) affectedworlds[worldid] = {};
                    affectedworlds[worldid][instanceid] = true;
                }
            }
            
            if (this.statuschan) {
                this.dqueue(function() {
                    this.bakeStatus(userid, this._friends[vrcuserid]);
                }.bind(this));
            }

            this.updateAffectedWorlds(affectedworlds);
            this.updateAffectedInstances(affectedworlds);
        }

        let friendAddHandler = (vrcuserid, userdata) => {
            let userid = this.getUseridByVrc(vrcuserid);
            let person = this.getPerson(userid);
            this._friends[vrcuserid] = userdata;
            if (person && !person.confirmed) {
                this.confirmPerson(userid);
                this.assignKnownRole(userid, "User is now confirmed.");
                this.announce("I see you, " + this.denv.idToDisplayName(userid) + "! You're my VRChat friend.");
            }
        }

        let friendDeleteHandler = (vrcuserid) => {
            let userid = this.getUseridByVrc(vrcuserid);
            let person = this.getPerson(userid);
            if (person && person.confirmed) {
                this.unconfirmPerson(userid);
                this.unassignKnownRole(userid, "User is no longer confirmed.");
                this.announce("Uh oh... " + this.denv.idToDisplayName(userid) + " is no longer my friend.");
            }
        }

        let friendUpdateHandler = (vrcuserid, userdata) => {
            let userid = this.getUseridByVrc(vrcuserid);

            if (userdata.state) delete userdata.state;

            if (!this._friends[vrcuserid]) this._friends[vrcuserid] = {};

            if (this.param("statedebug")) {
                let person = this.getPerson(userid);
                for (let key in userdata) {
                    if (this._friends[vrcuserid][key] != userdata[key]) {
                        this.log("-> Update >> " + person.name + " " + key + " (" + this._friends[vrcuserid][key] + " -> " + userdata[key] + ")");
                    }
                }
            }

            Object.assign(this._friends[vrcuserid], userdata);

            if (this.statuschan && this.isBakeStale(userid)) {
                this.dqueue(function() {
                    this.bakeStatus(userid, this._friends[vrcuserid]);
                    if (this._friends[vrcuserid].location) {
                        let worldid = this.worldFromLocation(this._friends[vrcuserid].location);
                        if (worldid) {
                            this.updateAffectedWorlds({[worldid]: true});
                        }
                    }
                }.bind(this));
            }
        }

        //Initialize VRChat session

        let startup = this.vrcConfig();

        if (this.param("usewebsocket")) {
            startup.then(() => this.vrcInitialize())
                .then(handlers => {
                    handlers.friendStateChange = friendStateChangeHandler;
                    handlers.friendLocationChange = friendLocationChangeHandler;
                    handlers.friendAdd = friendAddHandler;
                    handlers.friendDelete = friendDeleteHandler;
                    handlers.friendUpdate = friendUpdateHandler;
                })
        }

        startup.then(() => this.refreshFriends(true));
        startup.catch((e) => {
            this.log("error", "Failed to initialize VRChat module. Error:" + JSON.stringify(e));
            process.exit(11);
        });
            

        //# Start automation timers

        this._dtimer = setInterval(function () {

            if (!this._dqueue) return;
            let item = this._dqueue.shift();
            if (!item) return;
            item();

        }.bind(this), this.param("ddelay"));


        let maintimer = async function () {

            let now = moment().unix();

            //Refresh VRChat friends

            let reallymissing = [];
            if (this.areFriendsStale(now)) {
                await this.vrcMe();
                let missing  = await this.refreshFriends();
                reallymissing = await this.checkMissingPeopleIndividually(missing);
            }

            if (!this._frupdated) {
                this.log("error", "Friends list hasn't been initialized: Update will not run.");
                return;
            }

            //Unconfirm removed friends

            for (let vrcuserid of reallymissing) {
                let userid = this.getUseridByVrc(vrcuserid);
                let person = this.getPerson(userid);
                if (!person || !person.confirmed) continue;
                this.unconfirmPerson(userid);
                this.unassignKnownRole(userid, "User is no longer confirmed.");
                this.announce("Uh oh... " + this.denv.idToDisplayName(userid) + " is no longer my friend.");
            }

            //Remove absent and inactive users

            let personGone = (userid, person) => {
                if (this.statuschan && person.msg) {
                    this.statuschan.messages.fetch(person.msg)
                        .then((message) => {
                            if (message) message.delete();
                        })
                        .catch(() => {});
                }
    
                this.unassignKnownRole(userid, "User is no longer confirmed.");
                this.unregisterPerson(userid);
            }

            for (let userid in this._people) {
                let person = this.getPerson(userid);
                if (!STATUS_ONLINE.includes(person.lateststatus) && person.latestflip && now - person.latestflip > this.param("absence") * 86400) {
                    personGone(userid, person);
                    this.vrcUnfriend(person.vrc);
                    this.announce("<@" + userid + "> I haven't seen you in VRChat in more than " + this.param("absence") + " days, so I'm forgetting you. If you return, use `vrchat assign` to become friends again!");
                } else if (person.latestdiscord && now - person.latestdiscord > this.param("inactivity") * 86400) {
                    personGone(userid, person);
                    this.announce("<@" + userid + "> I haven't seen you say or do anything in more than " + this.param("inactivity") + " days, so I'm forgetting you. If you return, use `vrchat assign` to become friends again!");
                }
            }

            //Do things to friends

            let hasStatuschan = !!this.statuschan;
            let affectedworlds = {};

            for (let userid in this._people) {
                let person = this.getPerson(userid);

                /* === Websocket fallbacks === */

                //Confirm or expire unconfirmed user (keep on top)
                if (!person.confirmed) {
                    if (this._friends[person.vrc]) {
                        this.confirmPerson(userid);
                        this.assignKnownRole(userid, "User is now confirmed.");
                        this.announce("I see you, " + this.denv.idToDisplayName(userid) + "! You're my VRChat friend.");
                    } else {
                        if (now - person.waiting > this.param("expiration") * 3600) {
                            this.unregisterPerson(userid);
                        }
                        continue;
                    }
                }

                if (!this._friends[person.vrc]) continue;  //Friend not yet cached

                //Update latest location (used in world embeds)
                let location = this._friends[person.vrc].location;
                if (location && (location == "offline" || location == "private")) location = "";
                if (person.latestlocation != location) {
                    
                    if (this.param("statedebug")) {
                        this.log("!> Location >> " + person.name + " " + location);
                    }

                    let oldworldid = this.worldFromLocation(person.latestlocation), oldinstanceid = this.instanceIdFromLocation(person.latestlocation);
                    if (oldworldid && !person.sneak && !person.invisible) {
                        this.removeWorldMember(oldworldid, userid);
                        if (!affectedworlds[oldworldid]) affectedworlds[oldworldid] = {};
                        affectedworlds[oldworldid][oldinstanceid] = true;
                    }
                    this.updateLocation(userid, location);
                    let worldid = this.worldFromLocation(location), instanceid = this.instanceIdFromLocation(location);
                    if (worldid && !person.sneak && !person.invisible) {
                        this.addWorldMember(worldid, location, userid);
                        if (!affectedworlds[worldid]) affectedworlds[worldid] = {};
                        affectedworlds[worldid][instanceid] = true;
                    }
                }

                //Update saved status and announce changes
                if (this.param("statedebug") && person.lateststatus != this._friends[person.vrc].status) {
                    this.log("!> Status >> " + person.name + " " + this._friends[person.vrc].status);
                }
                this.updateStatus(userid, this._friends[person.vrc].status);
                if (person.pendingflip && now - person.latestflip >= this.param("offlinetolerance")) {
                    if (this.param("statedebug")) this.log("!> Flip (timer) >> " + person.name);
                    this.finishStatusUpdate(userid);
                }

                /* === Other sync === */

                //Update stored vrchat name
                this.setPersonName(userid, this._friends[person.vrc].displayName);

                //Update stored avatar picture location
                if (!person.stickypic) {
                    this.updatePic(userid, this._friends[person.vrc].currentAvatarImageUrl);
                }

                //Synchronize nickname with vrchat username
                if (person.syncnick) {
                    let member = this.denv.server.members.cache.get(userid);
                    if (member && member.displayName.toLowerCase() != this._friends[person.vrc].displayName.toLowerCase()) {
                        member.setNickname(this._friends[person.vrc].displayName, "Synchronizing nickname with VRChat.")
                            .catch(e => this.log("error", "Error setting nickname of " + member.displayName + " to " + this._friends[person.vrc].displayName + ": " + e));
                    }
                }

                //Update stored trust and announce if pertinent
                this.updateTrust(userid, this.highestTrustLevel(this._friends[person.vrc].tags));

                //Bake status embed
                if (hasStatuschan && this.isBakeStale(userid, now)) {
                    this.dqueue(function() {
                        this.bakeStatus(userid, this._friends[person.vrc], now);
                    }.bind(this));
                }

            }

            //Updated affected worlds
            this.updateAffectedWorlds(affectedworlds, now);
            this.updateAffectedInstances(affectedworlds);

            //Update previous world member counts.
            //We only add this to the queue so it's executed after all affected worlds have been baked (bakeWorld uses this to decide whether to reemit).

            this.dqueue(function() {
                for (let worldid in this._worlds) {
                    this.updatePrevMemberCount(worldid);
                }
            }.bind(this));

        }.bind(this);

        this._timer = setInterval(maintimer, this.param("updatefreq") * 1000);
        if (this.param("updatefreq") >= 40) setTimeout(maintimer, 20000);  //Run faster at startup


        if (this.param("usewebsocket") && this.param("updatefreq") > 300) {
            this._qtimer = setInterval(function () {

                let now = moment().unix();

                for (let userid in this._people) {
                    let person = this.getPerson(userid);

                    //Finish pending updates to offline status
                    if (person.pendingflip && now - person.latestflip >= this.param("offlinetolerance")) {
                        if (this.param("statedebug")) this.log("!> Flip (det) >> " + person.name);
                        this.finishStatusUpdate(userid);
                    }

                }

            }.bind(this), 59070);  //Don't align with maintimer
        }


        this._wtimer = setInterval(async function () {

            let now = moment().unix();

            //Remove old worlds from the cache

            let worldclears = [];

            for (let worldid in this._worlds) {
                let world = this.getCachedWorld(worldid);
                if (world.emptysince && now - world.emptysince > this.param("worldexpiration") * 3600
                        || !world.emptysince && !this.worldMemberCount(worldid)) {
                    worldclears.push(this.clearWorld(worldid));
                }
            }

            await Promise.all(worldclears);  //Some clears are queued and only resolve later
            this._worlds.save();

            //Update cached worlds

            let hasWorldchan = !!this.worldchan;
            let worldidsbyretrieval = Object.keys(this._worlds).sort((a, b) => this.getCachedWorld(a).retrieved < this.getCachedWorld(b).retrieved ? -1 : 1);
            let refreshed = 0;

            for (let worldid of worldidsbyretrieval) {
                let world = this.getCachedWorld(worldid);
                
                let retrieved = world?.retrieved;
                world = await this.getWorld(worldid);

                if (!world) continue;
                if (world.retrieved != retrieved) refreshed += 1;

                if (hasWorldchan) {
                    this.dqueue(function() {
                        let oldmsgid = world.msg;
                        this.bakeWorld(worldid, now)
                            .then(worldmsg => {
                                //Update user links only if world message was reemitted
                                if (worldmsg && worldmsg.id != oldmsgid && !this.instancechan) {
                                    for (let userid in world.members) {
                                        this.dqueue(function() {
                                            this.setWorldLink(userid, world.name, worldmsg);
                                        }.bind(this));
                                    }
                                }
                            })
                    }.bind(this));
                }

                if (refreshed >= this.param("staleupdatesperitr")) break;
            }
            

        }.bind(this), this.param("worldfreq") * 1000);


        //# Register commands

        this.mod('Commands').registerRootDetails(this, 'vrchat', {description: "Control integration with your VRChat account."});
        
        let asscall = async (env, userid, discorduser, vrchatuser, ep) => {

            if (!this.testEnv(env)) return true;

            let targetid = userid;

            if (discorduser) {
                targetid = env.displayNameToId(discorduser);
                if (!targetid) {
                    ep.reply("There is no such Discord user.");
                    return true;
                }
            }

            if (this.isValidUser(vrchatuser) && this.getPerson(targetid) && this.getPerson(targetid).vrc == vrchatuser) {
                ep.reply("VRChat account unchanged.");
                return true;
            }

            try {
            
                let data = await this.vrcUser(vrchatuser);
                if (!data) {
                    let search = await this.vrcUserSearch(vrchatuser);
                    if (search && search[0]) {
                        if (search[0].displayName.toLocaleLowerCase() == vrchatuser.toLocaleLowerCase()) {
                            data = search[0];
                        } else {
                            ep.reply("There is no user with the ID or display name " + vrchatuser + ", but there is a user with the display name " + search[0].displayName + " whose ID is `" + search[0].id + "`. Is this you?");
                            return true;
                        }
                    } else {
                        ep.reply("There is no user with the ID or display name " + vrchatuser + " .");
                        return true;
                    }
                }

                if (!this.getPerson(targetid)) {
                    this.registerPerson(targetid, {vrc: data.id});
                }

                if (!data.isFriend) {
                    let fstatus = await this.vrcFriendStatus(data.id);
                    if (!fstatus || (!fstatus.isFriend && !fstatus.outgoingRequest)) {
                        await this.vrcFriendRequest(data.id);
                        ep.reply("VRChat account learned. I've sent you a friend request! Please accept it.");
                    } else if (fstatus.outgoingRequest) {
                        ep.reply("VRChat account learned. Please accept my pending friend request!");
                    }
                } else {
                    this.confirmPerson(userid);
                    this.assignKnownRole(userid, "User is now confirmed.");
                    ep.reply("VRChat account learned.");
                }

            } catch (e) {
                if (e.statusCode == 403 || e.statusCode == 404) {
                    ep.reply("Couldn't query the VRChat API. Try again later? Contact an admin if this problem persists.");
                }
            };

            return true;
        };

        this.mod('Commands').registerCommand(this, 'vrchat assign', {
            description: "Assigns a VRChat user to you.",
            details: [
                "A friend request will be sent from the user '" + this.param("username") + "'."
            ],
            args: ["vrchatuser", true],
            minArgs: 1,
            types: ["regular"]
        },  (env, type, userid, channelid, command, args, handle, ep) => asscall(env, userid, null, args.vrchatuser.join(" "), ep));

        this.mod('Commands').registerCommand(this, 'vrchat assignto', {
            description: "Assigns a VRChat user to a Discord user.",
            details: [
                "If the Discord user is not provided, the current user is assumed.",
                "A friend request will be sent from the user '" + this.param("username") + "'."
            ],
            args: ["vrchatuser", "discorduser", true],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        },  (env, type, userid, channelid, command, args, handle, ep) => asscall(env, userid, args.discorduser.join(" "), args.vrchatuser, ep));


        let unasscall = (env, userid, discorduser, ep, unfriend) => {

            if (!this.testEnv(env)) return true;

            let targetid = userid;
        
            if (discorduser) {
                targetid = env.displayNameToId(discorduser);
                if (!targetid) {
                    ep.reply("There is no such Discord user.");
                    return true;
                }
            }

            let person = this.getPerson(targetid);
            if (!person) {
                ep.reply("This user doesn't have a known VRChat account.");
                return true;
            }

            if (this.statuschan && person.msg) {
                this.statuschan.messages.fetch(person.msg)
                    .then((message) => { message.delete(); })
                    .catch((e) => { this.log("warn", "Failed to delete unassigned user's message: " + JSON.stringify(e)); });
            }

            this.unassignKnownRole(targetid, "User is no longer confirmed.");

            this.unregisterPerson(targetid);
            ep.reply("VRChat account unlearned.");

            if (unfriend) {
                this.vrcUnfriend(person.vrc)
                    .then(() => {
                        ep.reply("And we are no longer friends!");
                    });
            }

            return true;
        };

        this.mod('Commands').registerCommand(this, 'vrchat unassign', {
            description: "Unassigns your VRChat user.",
            types: ["regular"]
        },  (env, type, userid, channelid, command, args, handle, ep) => unasscall(env, userid, null, ep));

        this.mod('Commands').registerCommand(this, 'vrchat unassignfrom', {
            description: "Unassigns a Discord user's VRChat user.",
            details: [
                "If the Discord user is not provided, the current user is assumed."
            ],
            args: ["discorduser", true],
            minArgs: 0,
            permissions: [PERM_ADMIN]
        },  (env, type, userid, channelid, command, args, handle, ep) => unasscall(env, userid, args.discorduser.join(" "), ep));

        this.mod('Commands').registerCommand(this, 'vrchat delete', {
            description: "Unassigns your VRChat user and unfriends it.",
            details: [
                "If you want to assign again at a later date, you will have to accept my friend request again."
            ],
            types: ["regular"]
        },  (env, type, userid, channelid, command, args, handle, ep) => unasscall(env, userid, null, ep, true));

        this.mod('Commands').registerCommand(this, 'vrchat deletefrom', {
            description: "Unassigns a Discord user's VRChat user and unfriends it.",
            details: [
                "If the Discord user is not provided, the current user is assumed.",
                "If you want to assign again at a later date, you will have to accept my friend request again."
            ],
            args: ["discorduser", true],
            minArgs: 0,
            permissions: [PERM_ADMIN]
        },  (env, type, userid, channelid, command, args, handle, ep) => unasscall(env, userid, args.discorduser.join(" "), ep, true));


        this.mod('Commands').registerCommand(this, 'vrchat syncnick', {
            description: "Automatically synchronize your Discord nickname with your VRChat username.",
            args: ["state"],
            minArgs: 0
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;

            let person = this.getPerson(userid);
            if (!person) {
                ep.reply("This user doesn't have a known VRChat account.");
                return true;
            }

            let state = this.processBooleanArg(args.state);
            if (state === undefined) {
                if (person.syncnick) {
                    ep.reply("Nickname synchronization is on.");
                } else {
                    ep.reply("Nickname synchronization is off.");
                }
                return true;
            }

            if (state) {
                this._people[userid].syncnick = true;
                ep.reply("Nickname synchronization enabled.");
            } else {
                this._people[userid].syncnick = false;
                ep.reply("Nickname synchronization disabled.");
            }

            this._people.save();
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrchat stickypic', {
            description: "Retain your current avatar picture on Discord even if your avatar changes.",
            args: ["state"],
            minArgs: 0
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;

            let person = this.getPerson(userid);
            if (!person) {
                ep.reply("This user doesn't have a known VRChat account.");
                return true;
            }

            let state = this.processBooleanArg(args.state);
            if (state === undefined) {
                if (person.stickypic) {
                    ep.reply("Sticky avatar picture is on.");
                } else {
                    ep.reply("Sticky avatar picture is off.");
                }
                return true;
            }

            if (state) {
                this._people[userid].stickypic = true;
                ep.reply("Sticky avatar picture enabled.");
            } else {
                this._people[userid].stickypic = false;
                ep.reply("Sticky avatar picture disabled.");
            }

            this._people.save();
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrchat sneak', {
            description: "Disable location tracking for one session.",
            args: ["state"],
            minArgs: 0
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;

            let person = this.getPerson(userid);
            if (!person) {
                ep.reply("You don't have a known VRChat account.");
                return true;
            }

            let state = this.processBooleanArg(args.state);
            if (state === undefined) {
                if (person.sneak) {
                    ep.reply("Sneaking is on.");
                } else {
                    ep.reply("Sneaking is off.");
                }
                return true;
            }

            if (this._people[userid].invisible && state) {
                ep.reply("You're invisible. No need to sneak!");
                return true;
            }

            if (this._sneaks[userid]) {
                delete this._sneaks[userid];
            }

            let friend = this._friends[person.vrc];

            if (state) {

                let worldid = this.worldFromLocation(person.latestlocation), instanceid = this.instanceIdFromLocation(person.latestlocation);
                if (worldid) {
                    this.removeWorldMember(worldid, userid);
                    if (friend) {
                        this.dqueue(function () {
                            this.bakeStatus(userid, friend);
                        }.bind(this));
                    }
                    let affectedworlds = {[worldid]: {[instanceid]: true}};
                    this.updateAffectedWorlds(affectedworlds);
                    this.updateAffectedInstances(affectedworlds);
                }

                this._people[userid].sneak = true;
                ep.reply("Sneaking enabled.");
            } else {
                this._people[userid].sneak = false;
                ep.reply("Sneaking disabled.");

                let worldid = this.worldFromLocation(person.latestlocation), instanceid = this.instanceIdFromLocation(person.latestlocation);
                if (worldid) {
                    this.addWorldMember(worldid, person.latestlocation, userid)
                        .then(() => { if (friend) this.bakeStatus(userid, friend); })
                        .then(() => {
                            let affectedworlds = {[worldid]: {[instanceid]: true}};
                            this.updateAffectedWorlds(affectedworlds);
                            this.updateAffectedInstances(affectedworlds);
                        });
                }
            }

            this._people.save();
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrchat invisible', {
            description: "Disable status tracking for one session.",
            args: ["state"],
            minArgs: 0
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;

            let person = this.getPerson(userid);
            if (!person) {
                ep.reply("You don't have a known VRChat account.");
                return true;
            }

            let state = this.processBooleanArg(args.state);
            if (state === undefined) {
                if (person.invisible) {
                    ep.reply("Invisibility is on.");
                } else {
                    ep.reply("Invisibility is off.");
                }
                return true;
            }

            if (this._invisibles[userid]) {
                delete this._invisibles[userid];
            }

            let friend = this._friends[person.vrc];

            if (state) {

                let worldid = this.worldFromLocation(person.latestlocation), instanceid = this.instanceIdFromLocation(person.latestlocation);
                if (worldid) {
                    this.removeWorldMember(worldid, userid);
                    if (friend) {
                        this.dqueue(function () {
                            this.bakeStatus(userid, friend);
                        }.bind(this));
                    }
                    let affectedworlds = {[worldid]: {[instanceid]: true}};
                    this.updateAffectedWorlds(affectedworlds);
                    this.updateAffectedInstances(affectedworlds);
                }

                if (this._people[userid].sneak) {
                    this._people[userid].sneak = false;
                    ep.reply("Sneaking disabled.");
                }
                this._people[userid].invisible = true;
                ep.reply("Invisibility enabled.");
            } else {
                this._people[userid].invisible = false;
                ep.reply("Invisibility disabled.");

                let worldid = this.worldFromLocation(person.latestlocation), instanceid = this.instanceIdFromLocation(person.latestlocation);
                if (worldid) {
                    this.addWorldMember(worldid, person.latestlocation, userid)
                        .then(() => { if (friend) this.bakeStatus(userid, friend); })
                        .then(() => {
                            let affectedworlds = {[worldid]: {[instanceid]: true}};
                            this.updateAffectedWorlds(affectedworlds);
                            this.updateAffectedInstances(affectedworlds);
                        });
                }
            }

            this._people.save();
            return true;
        });


        this.mod('Commands').registerRootDetails(this, 'vrcany', {description: "Return a link to a random VRChat element."});


        this.mod('Commands').registerCommand(this, 'vrcany user', {
            description: "Obtain a random known user."
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            let person = this.randomPerson();
            if (!person) {
                ep.reply("I don't know anyone yet!");
                return true;
            }
            
            ep.reply("**" + env.idToDisplayName(person.key) + "**" + (this.statuschan ? " - " + this.getPersonMsgURL(person.key) : ""));

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcany onlineuser', {
            description: "Obtain a random online known user."
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            let person = this.randomPerson(people => userid => STATUS_ONLINE.includes(people[userid].lateststatus) && !people[userid].invisible);
            if (!person) {
                ep.reply("No one is online!");
                return true;
            }
            
            ep.reply("**" + env.idToDisplayName(person.key) + "**" + (this.statuschan ? " - " + this.getPersonMsgURL(person.key) : ""));

            return true;
        });

        if (this.param("worldchan")) {

            let worldfilter = (worlds, worldid, filters) => this.matchAgainstFilters(worlds[worldid], filters.join(" "), [
                    (world, filter) => world.name?.toLowerCase().indexOf(filter) > -1,
                    (world, filter) => world.description?.toLowerCase().indexOf(filter) > -1,
                    (world, filter) => world.authorName?.toLowerCase().indexOf(filter) > -1,
                    (world, filter) => {
                        for (let tag of world.tags) {
                            if (!tag.match(/^author_tag/)) continue;
                            tag = tag.replace(/author_tag_/, "").replace(/_/g, "");
                            if (tag == filter) return true;
                        }
                    }
                ]);

            this.mod('Commands').registerCommand(this, 'vrcany recentworld', {
                description: "Obtain a random recently seen (cached) world.",
                args: ["filter", true],
                minArgs: 0
            },  (env, type, userid, channelid, command, args, handle, ep) => {

                if (!this.worldchan) return true;

                let filter = undefined;
                if (args.filter.length) {
                    filter = worlds => worldid => worldfilter(worlds, worldid, args.filter);
                }

                let world = this.randomWorld(filter);
                if (!world) {
                    ep.reply("I haven't seen any world recently" + (args.filter.length ? " matching your search" : "") + "!");
                    return true;
                }

                ep.reply("**" + world.name + "** - " + this.getWorldMsgURL(world.key));

                return true;
            });

            this.mod('Commands').registerCommand(this, 'vrcany activeworld', {
                description: "Obtain a random world currently in use by a known user.",
                args: ["filter", true],
                minArgs: 0
            },  (env, type, userid, channelid, command, args, handle, ep) => {

                if (!this.worldchan) return true;

                let filter = undefined;
                if (args.filter.length) {
                    filter = worlds => worldid => {
                        if (this.worldMemberCount(worldid) < 1) return false;
                        if (args.filter.length) {
                            return worldfilter(worlds, worldid, args.filter);
                        }
                        return true;
                    }
                }

                let world = this.randomWorld(filter);
                if (!world) {
                    ep.reply("No one is online in a visible world" + (args.filter.length ? " matching your search" : "") + "!");
                    return true;
                }

                ep.reply("**" + world.name + "** - " + this.getWorldMsgURL(world.key));

                return true;
            });

        }


        this.mod('Commands').registerRootDetails(this, 'vrcsave', {description: "Save backup data."});

        if (this.param("pinnedchan")) {

            this.mod('Commands').registerCommand(this, 'vrcany favorite', {
                description: "Obtain a random message from the pinned worlds channel.",
                args: ["filter", true],
                minArgs: 0
            },  (env, type, userid, channelid, command, args, handle, ep) => {

                if (!this.pinnedchan) return true;

                let filter = undefined;
                if (args.filter.length) {
                    filter = pins => worldid => {
                        let data = this.extractWorldFromMessage(pins[worldid], true);
                        return this.matchAgainstFilters(data, args.filter.join(" "), [
                            (data, filter) => data.title?.toLowerCase().indexOf(filter) > -1,
                            (data, filter) => data.description?.toLowerCase().indexOf(filter) > -1,
                            (data, filter) => {
                                if (data.tags) {
                                    for (let tag of data.tags) {
                                        if (tag == filter) return true;
                                    }
                                }
                            }
                        ]);
                    };
                }

                let message = this.randomPin(filter);
                if (!message) {
                    ep.reply("There are no pinned worlds" + (args.filter.length ? " matching your search" : "") + "!");
                    return true;
                }

                let data = this.extractWorldFromMessage(message, true);
                if (!data) return true;

                ep.reply("**" + data.title + "** - " + this.getPinnedMsgURL(message.id));

                return true;
            });


            this.mod('Commands').registerCommand(this, 'vrcsave favorites', {
                description: "Back up the list of pinned worlds.",
                permissions: [PERM_ADMIN],
                type: ["private"]
            },  (env, type, userid, channelid, command, args, handle, ep) => {

                if (!this.pinnedchan) return true;

                let favoritefile = this.loadData("favoritefile.json", {}, {pretty: true});

                this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                    let data = this.extractWorldFromMessage(message, true);
                    if (!data) return;
                    favoritefile[data.worldid] = data;
                }, () => {
                    favoritefile.save();
                    ep.ok();
                });

                return true;
            });

        }


        this.mod('Commands').registerCommand(this, 'vrcalert', {
            description: "Receive a DM alert when a certain amount of known users are online.",
            details: [
                "When at least PEOPLE users are online (minimum: " + this.param("alertmin") +") I will DM you.",
                "Optionally, those users must be within MINUTES from your timezone (use 0 to require your exact timezone).",
                "After an alert is sent, no more alerts will be sent for " + Math.floor(this.param("alertcooldown") / 60) + "h" + (this.param("alertcooldown") % 60 ? (this.param("alertcooldown") % 60) + "m" : "") + ".",
                "To disable the alert use `vrcalert -` ."
            ],
            args: ["people", "minutes"],
            minArgs: 1
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;

            let person = this.getPerson(userid);
            if (!person) {
                ep.reply("This user doesn't have a known VRChat account.");
                return true;
            }

            let minutes = null;
            if (this._modTime && args.minutes != null) minutes = Math.max(0, parseInt(args.minutes));

            if (args.people == "-" || args.people == "cancel" || args.people == "disable" || args.people == "off") {
                this.updateAlertParameters(userid, false);
                ep.reply("Alert unset.");
                return true;
            }

            let people = parseInt(args.people);
            if (people < this.param("alertmin")) {
                ep.reply("You can only set an alert for " + this.param("alertmin") + " or more online people.");
                return true;
            }

            let m = null;
            if (this._modTime) {
                m = this._modTime.getCurrentMomentByUserid(env, userid);
                if (minutes != null && !m) {
                    ep.reply("You don't have a timezone! Use `tz` to set your timezone or set an alert without a timezone interval.");
                    return true;
                }
            }

            this.updateAlertParameters(userid, people, minutes);
            ep.reply("Alert set for " + people + " or more people " + (m && minutes != null ? "within " + minutes + " minute" + (minutes != 1 ? "s" : "") + " of UTC" + m.format("Z") : "") + ".");

            return true;
        });


        this.mod('Commands').registerRootDetails(this, 'vrcount', {description: "Counters for registered VR elements."});

        this.mod('Commands').registerCommand(this, 'vrcount members', {
            description: "Returns the current amount of known users."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let count = Object.keys(this._people).length;
            if (count) {
                ep.reply(env.idToDisplayName(userid) + ": " + count);
            } else{
                ep.reply(env.idToDisplayName(userid) + ": I don't know anyone yet.");
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcount favorites', {
            description: "Returns the current amount of favorites."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let count = Object.keys(this._pins).length;
            if (count) {
                ep.reply(env.idToDisplayName(userid) + ": " + count);
            } else{
                ep.reply(env.idToDisplayName(userid) + ": There are no favorites yet.");
            }

            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcconfig pronouns', {
            description: "Sets the pronouns role color.",
            details: [
                "Use - to unset.",
                "Requires ReactionRoles."
            ],
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let color = args.color;
            if (color != "-" && !color.match(/^#[a-z0-9]{6}$/i)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }

            if (color == "-") {
                color = undefined;
            } else {
                color = color.toLowerCase();
                if (!this._modReactionRoles || !this._modReactionRoles.getGroup(color)) {
                    ep.reply("There is no ReactionRoles group with this color. Please create one first.");
                    return true;
                }
            }

            this.setPronounsColor(color);
            ep.ok();

            return true;
        });

        this.mod('Commands').registerCommand(this, 'vrcconfig addcolorgroup', {
            description: "Adds roles with a certain color to status embeds.",
            details: [
                "Requires ReactionRoles."
            ],
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let color = args.color;
            if (!color.match(/^#[a-z0-9]{6}$/i)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }

            if (!this._modReactionRoles || !this._modReactionRoles.getGroup(color)) {
                ep.reply("There is no ReactionRoles group with this color. Please create one first.");
                return true;
            }

            this.addStatusRoleGroup(color.toLowerCase());
            ep.ok();
    
            return true;
        });
    
        this.mod('Commands').registerCommand(this, 'vrcconfig delcolorgroup', {
            description: "Removes roles with a certain color from status embeds.",
            args: ["color"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
    
            let color = args.color;
            if (!color.match(/^#[a-z0-9]{6}$/i)) {
                ep.reply("Invalid color. Please use hexadecimal RGB format, for example #ab1257 .");
                return true;
            }

            this.delStatusRoleGroup(color.toLowerCase());
            ep.ok();
    
            return true;
        });
    

        this.mod('Commands').registerRootDetails(this, 'vrcfix', {description: "Manual fixes for VRChat elements."});

    
        this.mod('Commands').registerCommand(this, 'vrcfix updatefavorites', {
            description: "Refresh all favorites.",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.pinnedchan) {
                ep.reply("Favorites channel not found.");
                return true;
            }

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {
                let worldid = this.extractWorldFromMessage(message);
                if (!worldid) return;

                let world = await this.getWorld(worldid);
                if (!world) return;

                let emb = null;
                for (let checkembed of message.embeds) {
                    if (checkembed.type == "rich") {
                        emb = checkembed;
                        break;
                    }
                }
                if (!emb) return;

                let changed = false;

                //Fix basic
                if (emb.title != world.name) {
                    emb.setTitle(world.name);
                    changed = true;
                }

                if (emb.image != world.imageUrl) {
                    emb.setImage(world.imageUrl);
                    changed = true;
                }


                let body = [];
                body.push(world.description);
                body = body.join("\n\n");
                if (emb.description != body) {
                    emb.setDescription(body);
                    changed = true;
                }

                //Fix tags
                let tagsToDisplay = this.formatWorldTags(world.tags).join(", ");
                if (tagsToDisplay) {
                    let field = this.embedFieldByName(emb, "Tags");
                    if (field && field.value != tagsToDisplay) {
                        field.value = tagsToDisplay;
                        changed = true;
                    } else if (!field) {
                        emb.addField("Tags", tagsToDisplay);
                        changed = true;
                    }
                }

                if (changed) {
                    this.dqueue(function() {
                        message.edit({embeds: [emb], components: [this.worldInviteButtons()]});
                    }.bind(this));
                }

            }, () => {
                ep.reply("Done!");
            });

            ep.reply("Wait...");
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix convertfavorites', {
            description: "Extract pins from and remove messages from the favorites channel.",
            details: [
                "Note that converted messages are added to the end, so the end result might be in a different order.",
                "May overload the delay queue while in operation."
            ],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.pinnedchan) {
                ep.reply("Favorites channel not found.");
                return true;
            }

            let worldids = [];
            let deleted = 0;
            let pinned = 0;

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                if (message.author?.id == this.denv.server.me.id) return;

                let worldid = this.extractWorldFromMessage(message);
                if (worldid) worldids.push([worldid, message.author?.id]);
                for (worldid of this.extractWorldsFromText(message.content)) {
                    worldids.push([worldid, message.author?.id]);
                }

                this.dqueue(function() {
                    message.delete();
                }.bind(this));
                deleted += 1;

            }, () => {
                
                worldids.reverse();

                for (let desc of worldids) {
                    let worldid = desc[0], userid = desc[1];
                    if (this._pins[worldid]) {
                        let worldname = this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("The world " + worldname + " is already pinned.");
                        return true;
                    }
    
                    this.dqueue(function() {
                        this.potentialWorldPin(worldid, true, userid)
                            .then(result => {
                                if (!result) {
                                    let worldname = this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("Failed to pin the world " + worldname + " - does it still exist?");
                                } else {
                                    pinned += 1;
                                }
                            });
                    }.bind(this));
                }

                this.dqueue(function() {
                    ep.reply("Done! Pinned " + pinned + "/" + worldids.length + "; Deleted " + deleted + " message" + (deleted != 1 ? "s" : ""));
                }.bind(this));

            });

            ep.reply("Wait...");
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix removefavoritereacts', {
            description: "Remove reactions from the favorites channel.",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.pinnedchan) {
                ep.reply("Favorites channel not found.");
                return true;
            }

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                this.dqueue(function() {
                    message.reactions.removeAll();
                }.bind(this));
            }, () => {
                this.dqueue(function() {
                    ep.reply("Done!");
                }.bind(this));
            });

            ep.reply("Wait...");

            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix simulatestatus', {
            description: "Simulates a status update.",
            args: ["userid", "status"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let person = this.getPerson(args.userid);
            if (!person) {
                ep.reply("Not a member or not a known person.");
                return true;
            }

            this.updateStatus(args.userid, args.status);

            ep.reply("Done.");

            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix ldfromactivity', {
            description: "Updates person latestdiscord fields with data from the Activity module.",
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!modActivity) {
                ep.reply("Activity module not found.");
                return true;
            }

            let data = modActivity.getAllNickRegisters(this.param("env"));
            let count = 0;

            for (let actperson of data) {
                if (!actperson.last || !actperson.last.length) continue;
                let le = actperson.last[actperson.last.length - 1];
                if (this.setLatestDiscord(le[1], le[2])) {
                    count += 1;
                }
            }

            ep.reply("Ok. Updated people: " + count);

            return true;
        });

      
        return true;
    };



    // # Module code below this line #


    //Dynamic settings

    addStatusRoleGroup(color) {
        if (!color) return false;
        if (!this._misc.statusrolegroups) {
            this._misc.statusrolegroups = [];
        }
        if (!this._misc.statusrolegroups.includes(color)) {
            this._misc.statusrolegroups.push(color);
        }
        this._misc.save();
        return true;
    }

    delStatusRoleGroup(color) {
        if (!color) return false;
        if (!this._misc.statusrolegroups || !this._misc.statusrolegroups.includes(color)) return true;
        this._misc.statusrolegroups = this._misc.statusrolegroups.filter(checkcolor => checkcolor != color);
        this._misc.save();
        return true;
    }

    setPronounsColor(color) {
        if (color) {
            this._misc.pronounscolor = color;
        } else if (this._misc.pronounscolor) {
            delete this._misc.pronounscolor;
        }
        this._misc.save();
        return true;
    }


    //Manipulate index of known users (people)

    getPerson(userid) {
        if (!userid) return undefined;
        return this._people[userid];
    }

    getPersonByVrc(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) return undefined;
        for (let userid in this._people) {
            if (this._people[userid].vrc == vrcuserid) {
                return this._people[userid];
            }
        }
    }

    getUseridByVrc(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) return undefined;
        for (let userid in this._people) {
            if (this._people[userid].vrc == vrcuserid) {
                return userid;
            }
        }
    }

    registerPerson(userid, fields, keep) {
        let person = {
            vrc: null,                      //VRChat user ID
            msg: null,                      //Status message ID
            name: null,                     //Cached VRChat display name
            confirmed: false,               //Whether the user is confirmed (friended)
            syncnick: true,                 //Whether to automatically change user's nickname to VRChat username
            latestpic: null,                //Latest synced avatar picture
            stickypic: false,               //Whether NOT to sync avatar pictures (keep current)
            sneak: false,                   //Whether to track locations
            invisible: false,               //Whether to track status
            alert: null,                    //{people, tzrange} DM alerts
            latestalert: null,              //Timestamp of latest alert
            alertable: true,                //Whether user can be alerted at all (used to prevent multiple per session)
            lateststatus: null,             //Latest VRChat status (used to detect changes)
            latesttrust: null,              //Latest VRChat trust level (used to detect changes)
            latestlocation: null,           //Latest VRChat location (used for links)
            latestflip: null,               //Timestamp of latest flip between online/offline
            pendingflip: false,             //Whether there's a pending unannounced flip
            latestdiscord: moment().unix(), //Latest activity on Discord
            creation: moment().unix(),      //Timestamp of the creation of the person entry (unchanging)
            waiting: moment().unix(),       //Timestamp of the start of the current waiting period for friending
            baked: null                     //Timestamp of latest baking
        };
        if (keep && this._people[userid]) {
            person = this._people[userid];
        }
        if (fields) {
            for (let key in fields) {
                person[key] = fields[key];
            }
        }
        this._people[userid] = person;
        this._people.save();
        return person;
    }

    confirmPerson(userid) {
        if (!this._people[userid]) return false;
        this._people[userid].confirmed = true;
        this._people[userid].waiting = null;
        this._people.save();
        return true;
    }

    unconfirmPerson(userid) {
        if (!this._people[userid]) return false;
        if (this._friends[this._people[userid].vrc]) {
            delete this._friends[this._people[userid].vrc];
        }
        this._people[userid].confirmed = false;
        this._people[userid].waiting = moment().unix();
        this._people.save();
        return true;
    }

    setPersonName(userid, name) {
        if (!this._people[userid]) return false;
        this._people[userid].name = name;
        this._people.save();
        return true;
    }

    setPersonMsg(userid, message) {
        if (!this._people[userid] || !message) return false;
        this._people[userid].msg = message.id;
        this._people.save();
        return true;
    }

    clearPersonMsg(userid) {
        if (!this._people[userid]) return false;
        this._people[userid].msg = null;
        this._people.save();
        return true;
    }

    getPersonMsgURL(userid) {
        if (!this._people[userid] || !this._people[userid].msg || !this.statuschan) return "";
        return "https://discord.com/channels/" + this.denv.server.id + "/" + this.statuschan.id + "/" + this._people[userid].msg;
    }

    findPersonByMsg(msgid) {
        for (let userid in this._people) {
            if (this._people[userid].msg == msgid) {
                return userid;
            }
        }
        return null;
    }

    updatePic(userid, imageurl) {
        if (!this._people[userid]) return false;
        this._people[userid].latestpic = imageurl;
        this._people.save();
        return true;
    }

    updateStatus(userid, status) {
        if (!this._people[userid] || !status) return false;
        let prev = this._people[userid].lateststatus;
        if (prev == status) return false;
        this._people[userid].lateststatus = status;
        if (prev) {
            let now = moment().unix();

            if (!STATUS_ONLINE.includes(prev) && STATUS_ONLINE.includes(status)) {
                this._people[userid].latestflip = now;
                if (this._people[userid].pendingflip) {
                    //Cancel offline flip
                    this._people[userid].pendingflip = false;
                } else {
                    //Recover invisibility
                    if (this._invisibles[userid]) {
                        if (now - this._invisibles[userid] < this.param("anncollapsetrans")) {
                            this.setInvisible(userid, true);
                        }
                        delete this._invisibles[userid];
                    }
                    //Recover sneaking
                    if (this._sneaks[userid]) {
                        if (now - this._sneaks[userid] < this.param("anncollapsetrans")) {
                            this.setSneak(userid, true);
                        }
                        delete this._sneaks[userid];
                    }
                    if (!this._people[userid].invisible) {
                        //Announce to channel stack
                        if (this.param("useannstacks")) {
                            this.annOnline(userid);
                        }
                        //DM announcements
                        this.dqueue(function () {
                            this.deliverDMAlerts()
                        }.bind(this));
                    }
                }
            }

            if (STATUS_ONLINE.includes(prev) && !STATUS_ONLINE.includes(status)) {
                this._people[userid].latestflip = now;
                this._people[userid].pendingflip = true;
                //Delayed announcement is in timer
            }
        }
        this._people.save();
        return true;
    }

    updateTrust(userid, trust) {
        if (!this._people[userid] || trust === undefined) return false;
        let prev = this._people[userid].latesttrust;
        if (prev == trust) return false;
        this._people[userid].latesttrust = trust;
        if (prev) {
            this.announce(this.trustLevelIcon(prev) + TRUST_CHANGE_ICON + this.trustLevelIcon(trust) + " Trust change: **" + this.denv.idToDisplayName(userid) + "**");
        }
        this._people.save();
        return true;
    }

    setSneak(userid, sneak) {
        if (!this._people[userid]) return false;
        if (sneak == null) sneak = true;
        this._people[userid].sneak = !!sneak;
        this._people.save();
        return true;
    }

    setInvisible(userid, invisible) {
        if (!this._people[userid]) return false;
        if (invisible == null) invisible = true;
        this._people[userid].invisible = !!invisible;
        this._people.save();
        return true;
    }

    finishStatusUpdate(userid) {
        if (!this._people[userid].invisible && this.param("useannstacks")) {
            this.annOffline(userid);
        }
        let now = moment().unix();
        this._people[userid].pendingflip = false;
        if (this._people[userid].invisible) {
            this._invisibles[userid] = now;
            this._people[userid].invisible = false;
        }
        if (this._people[userid].sneak) {
            this._sneaks[userid] = now;
            this._people[userid].sneak = false;
        }
        this._people.save();
        this.resetDMAlerts();
    }

    updateLocation(userid, location) {
        if (location && (location == "offline" || location == "private")) location = "";
        if (!this._people[userid] || location && !this.isValidLocation(location)) return false;
        this._people[userid].latestlocation = location;
        this._people.save();
        return true;
    }

    updateAlertParameters(userid, people, tzrange) {
        if (!this._people[userid] || !people) return false;
        if (tzrange == null) tzrange = null; //normalize
        this._people[userid].alert = (people !== false ? {people: people, tzrange: tzrange}: null);
        this._people.save();
        return true;
    }

    canAlert(userid, now) {
        if (!this._people[userid] || !this._people[userid].alertable) return false;
        if (!this._people[userid].latestalert) return true;
        now = now || moment().unix();
        return now - this._people[userid].latestalert >= this.param("alertcooldown") * 60;
    }

    setAlerted(userid) {
        if (!this._people[userid]) return false;
        this._people[userid].latestalert = moment().unix();
        this._people[userid].alertable = false;
        this._people.save();
        return true;
    }

    resetAlerted(userid) {
        if (!this._people[userid]) return false;
        this._people[userid].alertable = true;
        this._people.save();
        return true;
    }

    setLatestDiscord(userid, now) {
        if (!this._people[userid]) return false;
        now = now || moment().unix();
        if (this._people[userid].latestdiscord && this._people[userid].latestdiscord >= now) return false;
        this._people[userid].latestdiscord = now;
        this._people.save();
        return true;
    }

    isBakeStale(userid, now) {
        if (!this._people[userid]) return false;
        if (!this._people[userid].baked) return true;
        now = now || moment().unix();
        return now - this._people[userid].baked >= this.param("bakestale");
    }

    setBaked(userid) {
        if (!this._people[userid]) return false;
        this._people[userid].baked = moment().unix();
        this._people.save();
        return true;
    }

    resetAllPersons() {
        for (let userid in this._people) {
            this._people[userid].latestlocation = null;
            this._people[userid].alertable = true;
            this._people[userid].latestalert = null;
        }
        this._people.save();
    }

    unregisterPerson(userid) {
        if (!this._people[userid]) return false;

        delete this._people[userid];
        this._people.save();

        for (let worldid in this._worlds) {
            this.removeWorldMember(worldid, userid);
        }

        return true;
    }

    randomPerson(makefilter) {
        return this.randomEntry(this._people, makefilter ? makefilter(this._people) : undefined);
    }


    //Manipulate known users role

    async assignKnownRole(userid, reason) {
        if (!this.param("knownrole") || !userid) return false;
        let member = this.denv.server.members.cache.get(userid);
        if (!member) return false;
        try {
            await member.roles.add(this.param("knownrole"), reason);
            return true;
        } catch (e) {
            return false;
        }
    }

    async unassignKnownRole(userid, reason) {
        if (!this.param("knownrole") || !userid) return false;
        let member = this.denv.server.members.cache.get(userid);
        if (!member) return false;
        try {
            await member.roles.remove(this.param("knownrole"), reason);
            return true;
        } catch (e) {
            return false;
        }
    }


    //Transient friend list (VRChat)

    async refreshFriends(reset) {
        let notupdated = {};
        if (reset || !this._friends) {
            this._friends = {};
        } else {
            for (let vrcuserid of Object.keys(this._friends)){
                notupdated[vrcuserid] = true;
            }
        }
        try {
            let friendlist = await this.vrcFriendList();
            for (let friend of friendlist) {
                if (friend.status != "offline" && (friend.location == "offline" || friend.location == "")) friend.status = "website";
                if (STATUS_ONLINE.includes(friend.status) && this._me.activeFriends.includes(friend.id)) friend.status = "website";
                this._friends[friend.id] = friend;
                if (notupdated[friend.id]) delete notupdated[friend.id];
            }
            this._frupdated = moment().unix();
        } catch (e) {
            this.log("error", "Refreshing friend list: " + JSON.stringify(e));
            return null;
        }
        return notupdated;
    }

    async checkMissingPeopleIndividually(missing) {
        //Doesn't update this._friends anymore
        let reallymissing = [];
        for (let userid in this._people) {
            let person = this.getPerson(userid);
            if (!this._friends[person.vrc] || missing && missing[person.vrc]) {
                try {
                    let vrcdata = await this.vrcUser(person.vrc);
                    if (!vrcdata || !vrcdata.friendKey) {
                        reallymissing.push(userid);
                    }
                } catch (e) {
                    this.log("error", "Attempting to retrieve missing friend: " + e + " (Assigned to " + userid + ")");
                    continue;
                }
            }
        }
        return reallymissing;
    }

    areFriendsStale(now) {
        if (!this._friends || !this._frupdated) return true;
        now = now || moment().unix();
        return now - this._frupdated >= this.param("friendliststale");
    }


    //Manipulate world/instances cache

    async getWorld(worldid, refresh, dontcache) {
        let msg = null, members = {}, instances = {}, emptysince = null, prevmembercount = 0;
        let cachedWorld = this.getCachedWorld(worldid);
        if (cachedWorld) {
            if (!refresh && moment().unix() - cachedWorld.retrieved < this.param("worldstale")) {
                return cachedWorld;
            }
            msg = cachedWorld.msg;
            members = cachedWorld.members;
            instances = cachedWorld.instances;
            emptysince = cachedWorld.emptysince;
            prevmembercount = cachedWorld.prevmembercount;
        }
        return this.vrcWorld(worldid)
            .then(data => {
                if (!data) return null;
                data.retrieved = moment().unix();       //Time retrieved/refreshed
                data.msg = msg;                         //Status message ID
                data.members = members;                 //Set of members known to be in-world (discord userids)
                data.instances = instances;             //{INSTANCEID: {msg: status message ID, instance: full instance, members: set of members}, ...}
                data.emptysince = emptysince;           //Time of departure of last member
                data.prevmembercount = prevmembercount; //Member count on the previous iteration
                if (!dontcache) this._worlds[worldid] = data;
                return data;
            })
            .catch((e) => {});
    }

    getCachedWorld(worldid) {
        return this._worlds[worldid];
    }

    async addWorldMember(worldid, location, userid) {
        try {
            let world = await this.getWorld(worldid);
            if (!world) throw {error: "Unable to retrieve world."};
            world.members[userid] = true;
            world.emptysince = null;

            let instance = this.instanceFromLocation(location), instanceid = this.instanceIdFromLocation(location);
            if (!world.instances[instanceid]) {
                world.instances[instanceid] = {msg: null, instance: instance, members: {}};
            }
            world.instances[instanceid].members[userid] = true;

        } catch (e) {
            this.log('warn', "Failed to add world member " + userid + " to " + worldid + ": " + JSON.stringify(e));
        }
    }

    async removeWorldMember(worldid, userid) {
        if (!this._worlds[worldid]) return;
        if (this._worlds[worldid].members[userid]) {
            delete this._worlds[worldid].members[userid];

            for (let instanceid in this._worlds[worldid].instances) {
                if (this._worlds[worldid].instances[instanceid].members[userid]) {
                    delete this._worlds[worldid].instances[instanceid].members[userid];
                    if (!Object.keys(this._worlds[worldid].instances[instanceid]).length
                            && !this._worlds[worldid].instances[instanceid].msg) {
                        delete this._worlds[worldid].instances[instanceid];
                    }
                    break;
                }
            }
        }
        if (!this.worldMemberCount(worldid)) {
            this._worlds[worldid].emptysince = moment().unix();
        }
    }

    worldMemberCount(worldid) {
        if (!this._worlds[worldid]) return 0;
        return Object.keys(this._worlds[worldid].members).length;
    }

    getWorldMsgURL(worldid) {
        if (!this._worlds[worldid] || !this._worlds[worldid].msg || !this.worldchan) return "";
        return "https://discord.com/channels/" + this.denv.server.id + "/" + this.worldchan.id + "/" + this._worlds[worldid].msg;
    }

    findInstanceByMsg(msgid) {
        for (let worldid in this._worlds) {
            for (let instanceid in this._worlds[worldid].instances) {
                if (this._worlds[worldid].instances[instanceid].msg == msgid) {
                    return [worldid, instanceid];
                }
            }
        }
        return null;
    }

    updatePrevMemberCount(worldid) {
        if (!this._worlds[worldid]) return undefined;
        this._worlds[worldid].prevmembercount = this.worldMemberCount(worldid);
        return this._worlds[worldid].prevmembercount;
    }

    setWorldMsg(worldid, message) {
        if (!this._worlds[worldid] || !message) return false;
        this._worlds[worldid].msg = message.id;
        return true;
    }

    setInstanceMsg(worldid, instanceid, message) {
        if (!this._worlds[worldid] || !this._worlds[worldid].instances[instanceid] || !message) return false;
        this._worlds[worldid].instances[instanceid].msg = message.id;
        return true;
    }

    clearWorldMsg(worldid) {
        if (!this._worlds[worldid]) return false;
        this._worlds[worldid].msg = null;
        return true;
    }

    clearInstanceMsg(worldid, instanceid) {
        if (!this._worlds[worldid] || !this._worlds[worldid].instances[instanceid]) return false;
        this._worlds[worldid].instances[instanceid].msg = null;
        return true;
    }

    async clearWorld(worldid) {
        if (!this._worlds[worldid]) return true;
        if (this._worlds[worldid].msg && this.worldchan) {
            this.dqueue(function() {
                try{ 
                    this.worldchan.messages.fetch(this._worlds[worldid].msg)
                        .then(message => message.delete())
                        .catch(() => {})
                        .finally(() => { delete this._worlds[worldid]; this._worlds.save(); });
                } catch (e) {
                    //World no longer exists locally
                }
            }.bind(this));
        } else {
            delete this._worlds[worldid];
            this._worlds.save();
        }
        return true;
    }

    clearInstance(worldid, instanceid, dontsave) {
        if (!this._worlds[worldid] || !this._worlds[worldid].instances[instanceid]) return false;
        let instance = this._worlds[worldid].instances[instanceid];
        if (instance.msg && this.instancechan) {
            this.dqueue(function() {
                this.instancechan.messages.fetch(instance.msg)
                    .then(message => {
                        //Delete instance first to prevent infinite recursion with the message deletion handler
                        delete this._worlds[worldid].instances[instanceid];
                        if (!dontsave) this._worlds.save();
                        message.delete();
                    })
                    .catch(() => {});
            }.bind(this));
        } else {
            delete this._worlds[worldid].instances[instanceid];
            if (!dontsave) this._worlds.save();
        }
        return true;
    }

    emptyWorlds() {
        let now = moment().unix();

        for (let userid in this._people) {
            if (!this._people[userid].latestlocation) continue;
            this._people[userid].latestlocation = null;
            this.dqueue(function() {
                this.clearStatus(userid);
            }.bind(this));
            this.dqueue(function() {
                this.clearInviteButton(userid);
            }.bind(this));
        }
        this._people.save();

        for (let worldid in this._worlds) {
            if (!this.worldMemberCount(worldid)) {
                if (!this._worlds[worldid].emptysince) {
                        this._worlds[worldid].emptysince = now;
                }
                continue;
            }
            for (let instanceid in this._worlds[worldid].instances) {
                this.clearInstance(worldid, instanceid, true);
            }
            this._worlds[worldid].members = {};
            this._worlds[worldid].emptysince = now;
            this.dqueue(function() {
                this.bakeWorld(worldid, now);
            }.bind(this));
        }
        this._worlds.save();
    }

    randomWorld(makefilter) {
        return this.randomEntry(this._worlds, makefilter ? makefilter(this._worlds) : undefined);
    }


    //Status embeds

    bakeStatus(userid, vrcdata, now) {
        if (!this._ready) return false;
        let person = this.getPerson(userid);
        if (!person || !vrcdata) return false;

        if (now) now = moment.unix(now);
        else now = moment();
        
        let message = null, emb = null;
        if (person.msg) {
            message = this.statuschan.messages.cache.get(person.msg);
        }

        if (message) {
            for (let checkembed of message.embeds) {
                if (checkembed.type == "rich") {
                    emb = checkembed;
                    break;
                }
            }
        }

        let previouslocationcontents = null;
        if (!emb) {
            emb = new MessageEmbed();
        } else {
            previouslocationcontents = emb.fields.find(field => field.name == "Location");
            if (previouslocationcontents) previouslocationcontents = previouslocationcontents.value;
        }

        let title = vrcdata.displayName;
        let pronouns = this.userEmbedPronouns(userid);
        if (pronouns) title += " " + pronouns;

        emb.setTitle(title);
        emb.setThumbnail(person.latestpic);
        emb.setColor(!person.invisible && STATUS_ONLINE.includes(vrcdata.status) ? this.param("coloronline") : this.param("coloroffline"));
        emb.setURL("https://vrchat.com/home/user/" + vrcdata.id);
        emb.fields = [];

        let trust = this.highestTrustLevel(vrcdata.tags);
        emb.addField("Trust", this.trustLevelIcon(trust) + " " + this.trustLevelLabel(trust), true);

        emb.addField("Status", this.statusLabel(person.invisible ? "offline" : vrcdata.status), true);

        if (vrcdata.location) {
            emb.addField("Location", person.invisible ? this.placeholderLocation("offline") : this.placeholderLocation(vrcdata.location, person.sneak, previouslocationcontents), true);
        }

        if (this._modReactionRoles && this._misc.statusrolegroups) {
            for (let rolecolor of this._misc.statusrolegroups) {
                let group = this._modReactionRoles.getGroup(rolecolor);
                let block = this.userEmbedRoleBlock(userid, rolecolor);
                emb.addField(group.label, block + ZWSP /*mobile layout fix*/, true);
            }
        }

        let body = [];
        
        if (vrcdata.statusDescription) body.push("*" + this.stripNormalizedFormatting(vrcdata.statusDescription.trim()) + "*");

        let clockline = [];
        let clock = this.userEmbedClock(userid);
        if (clock) clockline.push(clock);
        clockline = clockline.concat(this.flags(vrcdata.tags, userid));
        if (clockline.length) body.push(clockline.join(" "));

        if (vrcdata.bio) body.push(this.stripNormalizedFormatting(vrcdata.bio.trim()));

        let taglabels = this.tagLabels(vrcdata.tags).join("\n");
        if (taglabels) body.push(taglabels);

        emb.setDescription(body.join("\n\n"));

        if (vrcdata.last_login && vrcdata.status == "offline" && !person.pendingflip && !person.invisible) {
            if (person.latestflip) {
                emb.setFooter({text: "Last seen " + moment.unix(person.latestflip).from(now)});
            } else if (vrcdata.last_login) {
                emb.setFooter({text: "Last logged in " + moment(vrcdata.last_login).from(now)});
            }
        } else {
            emb.setFooter({text: ""});
        }

        let invitebutton = [];
        if (person.latestlocation && !person.sneak && !person.invisible) {
            invitebutton = [this.userInviteButton()];
        }

        let pr;
        if (message) {
            pr = message.edit({embeds: [emb], components: invitebutton});
        } else {
            pr = this.statuschan.send({embeds: [emb], components: invitebutton})
                    .then(newmessage => { this.setPersonMsg(userid, newmessage); return newmessage; });
        }

        pr.then((msg) => {
            this.setBaked(userid);
        });

        return true;
    }

    userEmbedClock(userid) {
        if (!this._modTime) return null;
        let m = this._modTime.getCurrentMomentByUserid(this.denv, userid);
        if (!m) return null;
        let chour = (m.hour() % 12) * 2;
        let cmin = m.minute();
        if (cmin >= 15 && cmin < 45) chour += 1;
        else if (cmin >= 45) {
            chour += 2;
            if (chour > 23) chour = 0;
        }
        return CLOCKS[chour] + " " + m.format("HH:mm (Z)");
    }

    userEmbedPronouns(userid) {
        if (!this._modReactionRoles || !this._misc.pronounscolor) return null;
        let member = this.denv.server.members.cache.get(userid);
        if (!member) return null;
        let result = [];
        for (let role of member.roles.cache.values()) {
            if (role.hexColor.toLowerCase() != this._misc.pronounscolor) continue;
            let roledata = this._modReactionRoles.getRole(role.id);
            if (roledata) {
                result.push(roledata.emoji);
            }
        }
        return result.join(" ");
    }

    userEmbedRoleBlock(userid, rolecolor) {
        if (!this._modReactionRoles) return null;
        let member = this.denv.server.members.cache.get(userid);
        if (!member) return null;
        let result = [];
        for (let role of member.roles.cache.values()) {
            if (role.hexColor.toLowerCase() != rolecolor) continue;
            let roledata = this._modReactionRoles.getRole(role.id);
            if (roledata) {
                result.push(roledata.emoji);
            }
        }
        return result.join("");
    }

    async clearStatus(userid) {
        let person = this.getPerson(userid);
        if (!person) return false;
        let message = null, emb = null;
        if (person.msg) {
            try {
                message = await this.statuschan.messages.fetch(person.msg);
            } catch (e) {}
        }
        if (message) {
            for (let checkembed of message.embeds) {
                if (checkembed.type == "rich") {
                    emb = checkembed;
                    break;
                }
            }
        }
        if (!emb) return false;
        for (let field of emb.fields) {
            if (field.name == "Status") {
                field.value = this.statusLabel("offline");
            }
            if (field.name == "Location") {
                field.value = "-";
            }
        }
        emb.setColor(this.param("coloroffline"));
        message.edit({embeds: [emb]});
        return true;
    }

    clearInviteButton(userid) {
        let person = this.getPerson(userid);
        if (!person || !person.msg) return false;
        let message = this.statuschan.messages.cache.get(person.msg);
        if (!message) return false;
        if (message.components.length) {
            message.edit({components: []});
        }
        return true;
    }


    /* Modes: "normal" (default) | "stark" (reduced content) | "text" (no links) */
    async bakeWorld(worldid, now, mode) {
        if (!mode) mode = "normal";
        let world = await this.getWorld(worldid);
        if (!world) return;

        let membercount = this.worldMemberCount(worldid);

        if (now) now = moment.unix(now);
        else now = moment();

        let message = null, emb = null;
        if (world.msg) {
            try {
                message = await this.worldchan.messages.fetch(world.msg)
            } catch (e) {}
            if (message && !world.prevmembercount && membercount) {
                //Force reset if transition is no members -> members
                message.delete().catch(() => {});
                message = null;
            }
        }

        if (message) {
            for (let checkembed of message.embeds) {
                if (checkembed.type == "rich") {
                    emb = checkembed;
                    break;
                }
            }
        }

        if (!emb) {
            emb = new MessageEmbed();
        }

        emb.setTitle(world.name);
        emb.setThumbnail(world.imageUrl);
        emb.setColor(membercount ? this.param("coloronline") : this.param("coloroffline"));
        emb.setURL("https://vrchat.com/home/world/" + worldid);

        emb.fields = [];
        if (mode == "normal") {
            let tags = this.formatWorldTags(world.tags);
            if (tags.length) {
                emb.addField("Tags", tags.join(", "));
            }

            emb.addField("Players", String(world.publicOccupants || "0"), true);
            emb.addField("Private", String(world.privateOccupants || "0"), true);
            emb.addField("Popularity",  "`" + ("#".repeat(world.popularity || 0) || "-") +  "`", true);
        }
        
        let body = [];

        if (mode == "normal") {
            body.push(world.description);
        }
        
        if (body.length) {
            emb.setDescription(body.join("\n\n"));
        }

        let members = [];
        if (!this.instancechan) {
            for (let userid in world.members) {
                let line, person = this.getPerson(userid);
                if (mode == "text") {
                    line = (person.name || this.denv.idToDisplayName(userid)) + " (" + this.instanceIdFromLocation(person.latestlocation) + ")";
                } else {
                    line = "[" + (person.name || this.denv.idToDisplayName(userid)) + "](" + this.getPersonMsgURL(userid) + ")"
                        + " ([" + this.instanceIdFromLocation(person.latestlocation) + "](" + this.linkFromLocation(person.latestlocation).replace(/\)/g, "\\)") + "))"
                        ;
                }
                members.push(line);
            }
        }

        if (members.length) {
            //Pack members into embed fields whose contents are safely <MAX_FIELDLEN long
            let fieldcount = 0;
            let val = members.shift();
            while (members) {
                let line = members.shift();
                if (!line) break;
                let newval = val + "\n" + line;
                if (newval.length < MAX_FIELDLEN) {
                    val = newval;
                    continue;
                }
                emb.addField(fieldcount ? "\u200b" : "In-world", val);
                fieldcount += 1;
                val = line;
            }
            if (val) emb.addField(fieldcount ? "\u200b" : "In-world", val);
        }

        emb.setFooter({text: "Retrieved " + moment.unix(world.retrieved).from(now)});

        try {
            if (message) {
                return await message.edit({embeds: [emb], components: [this.worldInviteButtons(!!this._pins[worldid])]});
            } else {
                return await this.worldchan.send({embeds: [emb], components: [this.worldInviteButtons(!!this._pins[worldid])]})
                    .then(newmessage => {
                        this.setWorldMsg(worldid, newmessage);
                        return newmessage;
                    });
            }
        } catch (e) {
            if (mode == "normal") return this.bakeWorld(worldid, now.unix(), "stark");
            if (mode == "stark") return this.bakeWorld(worldid, now.unix(), "text");
            this.log("warn", "Failed to bake " + worldid + " in text mode: " + JSON.stringify(e));
        };

    }


    async bakeInstance(worldid, instanceid) {
        let world = await this.getWorld(worldid);
        if (!world) return;

        let instance = world.instances[instanceid];
        if (!instance) return;

        let message = null, emb = null;
        if (instance.msg) {
            try {
                message = await this.instancechan.messages.fetch(instance.msg);
            } catch (e) {}
        }

        if (message) {
            for (let checkembed of message.embeds) {
                if (checkembed.type == "rich") {
                    emb = checkembed;
                    break;
                }
            }
        }

        if (!emb) {
            emb = new MessageEmbed();
        }

        emb.setTitle(world.name + "  (" + instanceid + ")");
        emb.setThumbnail(world.imageUrl);
        if (world.msg) {
            emb.setDescription("[Go to world](https://discord.com/channels/" + this.denv.server.id + "/" + this.worldchan.id + "/" + world.msg + ")");
        }
        
        let url = null;
        emb.fields = [];

        let members = [];
        for (let userid in instance.members) {
            let line, person = this.getPerson(userid);
            if (!url) url = this.linkFromLocation(person.latestlocation);
            line = "[" + (person.name || this.denv.idToDisplayName(userid)) + "](" + this.getPersonMsgURL(userid) + ")";
            members.push(line);
        }

        let invitebutton = [];
        if (url) {
            emb.setURL(url);
            invitebutton = [this.userInviteButton()];
        }

        if (members.length) {
            //Pack members into embed fields whose contents are safely <MAX_FIELDLEN long
            let fieldcount = 0;
            let val = members.shift();
            while (members) {
                let line = members.shift();
                if (!line) break;
                let newval = val + "\n" + line;
                if (newval.length < MAX_FIELDLEN) {
                    val = newval;
                    continue;
                }
                emb.addField(fieldcount ? "\u200b" : "In-world", val);
                fieldcount += 1;
                val = line;
            }
            if (val) emb.addField(fieldcount ? "\u200b" : "In-world", val);
        }

        try {
            if (message) {
                if (members.length) {
                    return await message.edit({embeds: [emb], components: message.components});
                } else {
                    this.clearInstance(worldid, instanceid);
                    return null;
                }
            } else {
                return await this.instancechan.send({embeds: [emb], components: invitebutton})
                    .then(newmessage => {
                        this.setInstanceMsg(worldid, instanceid, newmessage);
                        return newmessage;
                    });
            }
        } catch (e) {
            console.log("Bake instance:", e);
            this.log("warn", "Failed to bake " + worldid + ":" + instanceid + " : " + JSON.stringify(e));
        };

    }
    

    async setWorldLink(userid, worldname, worldmsg, instancemsg) {
        if (!userid || !worldname) return false;
        let person = this.getPerson(userid);
        if (!person) return false;
        let message;
        try {
            message = await this.statuschan.messages.fetch(person.msg);
        } catch (e) {}
        if (!message) return false;
        let emb = null;
        for (let checkembed of message.embeds) {
            if (checkembed.type == "rich") {
                emb = checkembed;
                break;
            }
        }
        if (!emb) return false;
        let field = emb.fields.find(field => field.name == "Location");
        if (!field) return false;
        let oldvalue = field.value;
        if (instancemsg) {
            field.value = "[" + worldname + "](https://discord.com/channels/" + this.denv.server.id + "/" + this.instancechan.id + "/" + instancemsg.id + ")";
        } else if (worldmsg) {
            field.value = "[" + worldname + "](https://discord.com/channels/" + this.denv.server.id + "/" + this.worldchan.id + "/" + worldmsg.id + ")";
        } else {
            field.value = worldname;
        }
        if (oldvalue != field.value) {
            message.edit({embeds: [emb]});
        }
        return true;
    }


    updateAffectedWorlds(affectedworlds, now) {
        if (!this.worldchan) return;
        now = now || moment().unix();
        for (let worldid in affectedworlds) {
            this.dqueue(function() {
                this.bakeWorld(worldid, now)
                    .then(worldmsg => {
                        if (!worldmsg || this.instancechan) return;
                        //Always update user links - world.members changed
                        let world = this.getCachedWorld(worldid);
                        for (let userid in world.members) {
                            this.dqueue(function() {
                                this.setWorldLink(userid, world.name, worldmsg);
                            }.bind(this));
                        }
                    })
                    .catch((e) => {
                        this.log("warn", "Update affected worlds: " + JSON.stringify(e));
                    });
            }.bind(this));
        }
    }    

    updateAffectedInstances(affectedinstances) {
        if (!this.instancechan) return;
        for (let worldid in affectedinstances) {
            for (let instanceid in affectedinstances[worldid]) {
                this.dqueue(function() {
                    this.bakeInstance(worldid, instanceid)
                        .then(instancemsg => {
                            if (!instancemsg) return;
                            let world = this.getCachedWorld(worldid);
                            let instance = world.instances[instanceid];
                            for (let userid in instance.members) {
                                this.dqueue(function() {
                                    this.setWorldLink(userid, world.name, null, instancemsg);
                                }.bind(this));
                            }
                        })
                        .catch((e) => {
                            this.log("warn", "Update affected instances: " + JSON.stringify(e));
                        });
                }.bind(this));
            }
        }
    }


    //Announcements

    announce(msg) {
        this.log(msg);
        let achan = this.announcechan;
        if (!achan || !msg) return false;
        this.denv.msg(achan.id, msg);
        return true;
    }

    annOnline(userid) {
        this.log(this.denv.idToDisplayName(userid) + " is online.");
        if (!this.announcechan) return false;
        let now = moment().unix();

        if (this.annReconnect(userid, now)) return true;

        //QuickPeek, Online -> Online
        let idx;
        if (now - this._lt_quickpeek.ts <= this.param("anncollapsetrans")) {
            idx = this._lt_quickpeek.stack.indexOf(userid);
            if (idx > -1) this._lt_quickpeek.stack.splice(idx, 1);
        }

        this.dqueue(async function () {
            let prev;
            if (idx !== undefined) {
                prev = await this.annStateStack(null, this._lt_quickpeek, true);
            }
            this.annStateStack(userid, this._lt_online, prev, true);
        }.bind(this));
        return true;
    }

    annOffline(userid) {
        this.log(this.denv.idToDisplayName(userid) + " is offline.");
        if (!this.announcechan) return false;
        let now = moment().unix();

        if (this.annQuickPeek(userid, now)) return true;

        //Reconnect, Offline -> Online
        let idx;
        if (now - this._lt_reconnect.ts <= this.param("anncollapsetrans")) {
            idx = this._lt_reconnect.stack.indexOf(userid);
            if (idx > -1) this._lt_reconnect.stack.splice(idx, 1);
        }

        this.dqueue(async function () {
            let prev;
            if (idx !== undefined) {
                prev = await this.annStateStack(null, this._lt_reconnect, true);
            }
            this.annStateStack(userid, this._lt_offline, prev);
        }.bind(this));
        return true;
    }

    annReconnect(userid, now) {
        now = now || moment().unix();

        //Offine, Online -> Reconnect
        let interv = now - this._lt_offline.ts;
        if (interv > this.param("anncollapsetrans")) return false;
        let idx = this._lt_offline.stack.indexOf(userid);
        if (idx < 0) return false;
        this._lt_offline.stack.splice(idx, 1);
        
        this.dqueue(async function () {
            let prev = await this.annStateStack(null, this._lt_offline, true);
            if (interv > this.param("annremovetransmin")) {
                this.annStateStack(userid, this._lt_reconnect, prev);
            } else if (prev && prev !== true) {
                prev.delete();
            }
        }.bind(this));

        return true;
    }

    annQuickPeek(userid, now) {
        now = now || moment().unix();

        //Online, Offline -> Quick peek
        let interv = now - this._lt_online.ts;
        if (interv > this.param("anncollapsetrans")) return false;
        let idx = this._lt_online.stack.indexOf(userid);
        if (idx < 0) return false;
        this._lt_online.stack.splice(idx, 1);

        this.dqueue(async function () {
            let prev = await this.annStateStack(null, this._lt_online, true);
            if (interv > this.param("annremovetransmin")) {
                this.annStateStack(userid, this._lt_quickpeek, prev);
            } else if (prev && prev !== true) {
                prev.delete();
            }
        }.bind(this));

        return true;
    }

    async annStateStack(userid, state, prevmessage, reemit) {
        //If userid is null, prevmessage can be true to retrieve stale message instead of deleting it (for reuse)
        //prevmessage will be used only instead of (re)emitting, otherwise it's deleted
        let now = moment().unix();

        //Create new stack (detach) if last stack is too old
        if (state.ts && now - state.ts > (this._lastAnnounceMessageId == state.msg ? this.param("anncollapseconsec") : this.param("anncollapse"))) {
            state.msg = null; state.ts = null; state.stack = [];
        }

        //Add or bump userid
        if (userid) {
            let idx = state.stack.indexOf(userid);
            if (idx > -1) state.stack.splice(idx, 1);
            state.stack.push(userid);
        }
        
        //Prepare list of users
        let txt = "";
        let prefix = state.prefix + ": ";
        let stack = state.stack;
        let extralen = 0;

        if (stack.length > this.param("annmaxstack")) {
            extralen = stack.length - this.param("annmaxstack");
            stack = stack.slice(0, this.param("annmaxstack"));
        }

        txt += "**" + stack.map(stackuserid => this.denv.idToDisplayName(stackuserid)).join("**, **") + "**";
        if (extralen) {
            txt += "and **" + extralen + "** other" + (extralen != 1 ? "s": "");
        }
        
        //Create, update or delete message.
        let ret;
        if (state.msg) {
            let message;
            try {
                message = await this.announcechan.messages.fetch(state.msg);
                if (!stack.length) {
                    if (prevmessage === true) {
                        ret = message;
                    } else {
                        message.delete();
                    }
                    state.msg = null;
                } else if (reemit) {
                    message.delete();
                    state.msg = null;
                } else {
                    message.edit(prefix + txt);
                }
            } catch (e) {}
        }
        if (!state.msg && stack.length) {
            let message;
            if (prevmessage) {
                message = prevmessage;
                message.edit(prefix + txt);
            } else {
                message = await this.denv.msg(this.announcechan, prefix + txt);
            }
            state.msg = message.id;
        } else if (prevmessage && prevmessage !== true) {
            prevmessage.delete();
        }

        state.ts = now;
        return ret;
    }


    mapOnlinePeople(timezones) {
        let onlinemap = {};
        for (let userid in this._people) {
            if (STATUS_ONLINE.includes(this._people[userid].lateststatus)) {
                onlinemap[userid] = (timezones && this._modTime ? this._modTime.getCurrentUtcOffsetByUserid(this.denv, userid) : true);
            }
        }
        return onlinemap;
    }

    deliverDMAlert(userid, count, isTimezone) {
        this.dqueue(function() {
            this.denv.msg(userid, "**" + count + "** friends of mine are currently online" + (isTimezone ? " near your timezone." : ""));
        }.bind(this));
    }

    deliverDMAlerts() {

        //Create map of online people

        let onlinemap = this.mapOnlinePeople(true);
        let onlinecount = Object.keys(onlinemap).length;

        //Alert whoever

        let now = moment().unix();

        for (let userid in this._people) {
            let person = this.getPerson(userid);
            if (onlinemap[userid] || !person.alert) continue;
            if (!this.canAlert(userid, now)) continue;
            
            //Simple alert (everyone)
            if (person.alert.tzrange == null && onlinecount >= person.alert.people) {
                this.deliverDMAlert(userid, onlinecount);
                this.setAlerted(userid);
                continue;
            }
            
            //Timezone-based
            if (person.alert.tzrange != null) {
                let offset = this._modTime.getCurrentUtcOffsetByUserid(this.denv, userid);
                let restrictedcount = 0;
                for (let userid in onlinemap) {
                    if (onlinemap[userid] && Math.abs(offset - onlinemap[userid]) <= person.alert.tzrange) {
                        restrictedcount += 1;
                    }
                }
                if (restrictedcount >= person.alert.people) {
                    this.deliverDMAlert(userid, restrictedcount, true);
                    this.setAlerted(userid);
                }
            }
        }

    }

    resetDMAlerts() {

        //Create map of online people

        let onlinemap = this.mapOnlinePeople(true);
        let onlinecount = Object.keys(onlinemap).length;

        //Reset alerts as soon as previous alert conditions are no longer met

        for (let userid in this._people) {
            let person = this.getPerson(userid);
            if (onlinemap[userid] || !person.alert) continue;
            
            if (person.alert.tzrange == null && onlinecount < person.alert.people) {
                this.resetAlerted(userid);
                continue;
            }

            if (person.alert.tzrange != null) {
                let offset = this._modTime.getCurrentUtcOffsetByUserid(this.denv, userid);
                let restrictedcount = 0;
                for (let userid in onlinemap) {
                    if (onlinemap[userid] && Math.abs(offset - onlinemap[userid]) <= person.alert.tzrange) {
                        restrictedcount += 1;
                    }
                }
                if (restrictedcount < person.alert.people) {
                    this.resetAlerted(userid);
                }
            }
        }

    }


    //Pin favorites

    async potentialWorldPin(message, byid, userid) {
        let worldid;
        if (byid) {
            worldid = message;
        } else {
            worldid = this.extractWorldFromMessage(message);
        }
        if (!worldid) return false;
        if (this._pins[worldid]) return false;

        let sharedBy = this.denv.idToDisplayName(userid);

        let world = this.getCachedWorld(worldid);
        if (!world) {
            if (byid) {
                world = await this.getWorld(worldid, false, true);
                if (!world) return false;
            } else {
                return false;
            }
        }

        let emb = new MessageEmbed();

        emb.setTitle(world.name);
        emb.setImage(world.imageUrl);
        emb.setURL("https://vrchat.com/home/world/" + worldid);

        emb.fields = [];
        let tags = this.formatWorldTags(world.tags);
        if (tags.length) {
            emb.addField("Tags", tags.join(", "), true);
        }

        if (sharedBy) {
            let msgurl = this.getPersonMsgURL(userid);
            if (msgurl) sharedBy = "[" + sharedBy + "](" + msgurl + ")";
            emb.addField("Pinned by", sharedBy, true);
        }

        let body = [];

        body.push(world.description);

        emb.setDescription(body.join("\n\n"));

        this._pins[worldid] = true;

        let post;

        if (this.param("pinnedwebhook")) {
            try {
                let member = await this.denv.server.members.fetch(userid);
                let webhook = await this.denv.getWebhook(this.pinnedchan, member);
                post = webhook.send({embeds: [emb], components: [this.worldInviteButtons()]});
            } catch (e) {}
        }
        if (!post) {
            post = this.pinnedchan.send({embeds: [emb], components: [this.worldInviteButtons()]});
        }

        return post.then(newmessage => {
                this._pins[worldid] = newmessage;
                return true;
            });
    }

    extractWorldFromMessage(message, verbose) {
        if (!message) return null;
        let emb = null;
        for (let checkembed of message.embeds) {
            if (checkembed.type == "rich") {
                emb = checkembed;
                break;
            }
        }
        if (!emb || !emb.url) return null;
        let match = emb.url.match(/wrld_[0-9a-f-]+/);
        if (match) {
            if (verbose) {
                let tags = [];
                let tagfield = emb.fields.find(field => field.name == "Tags");
                if (tagfield) {
                    tags = tagfield.value.split(",").map(tag => tag.trim());
                }
                return {
                    worldid: match[0],
                    title: emb.title,
                    color: emb.color,
                    url: emb.url,
                    image: emb.image,
                    thumbnail: emb.thumbnail,
                    description: emb.description,
                    tags: tags
                };
            } else {
                return match[0];
            }
        }
    }

    extractWorldsFromText(txt) {
        if (!txt) return [];
        return txt.match(/wrld_[0-9a-f-]+/g) || [];
    }

    extractOwnersFromPin(message) {
        if (!message) return null;
        let emb = null;
        for (let checkembed of message.embeds) {
            if (checkembed.type == "rich") {
                emb = checkembed;
                break;
            }
        }
        if (!emb) return null;
        let results = [];
        for (let field of emb.fields) {
            if (field.name.match(/^pinned by$/i)) {
                let extrs = field.value.match(/\[[^\]]+\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = this.findPersonByMsg(extrs[1]);
                    if (person) results.push(person);
                }
            }
        }
        return results;
    }

    getPinnedMsgURL(msgid) {
        if (!msgid || !this.pinnedchan) return "";
        return "https://discord.com/channels/" + this.denv.server.id + "/" + this.pinnedchan.id + "/" + msgid;
    }

    randomPin(makefilter) {
        return this.randomEntry(this._pins, makefilter ? makefilter(this._pins) : undefined);
    }


    //High level api methods

    async vrcConfig() {
        return this.vrcget("config").then(data => { if (data) this._config = data; });
    }

    async vrcTime() {
        return this.vrcget("time");
    }

    async vrcVisits() {
        return this.vrcget("visits");
    }

    async vrcMe() {
        return this.vrcget("auth/user").then(data => { if (data) this._me = data; });
    }

    async vrcUserSearch(query) {
        return this.vrcget("users/?n=1&search=" + encodeURIComponent(query));
    }

    async vrcUser(vrcuser) {
        if (!this.isValidUser(vrcuser)) return null;
        return this.vrcget("users/" + get);
    }

    async vrcFriendList(state) {
        let list = [];
        if (!state || state == "online") {
            let onlist = await this.vrcget("auth/user/friends/?offline=false");
            if (!onlist) throw {error: "Failure to retrieve friend list."};
            list = list.concat(onlist);
        }
        if (!state || state == "offline") {
            let offlist = await this.vrcget("auth/user/friends/?offline=true");
            if (!offlist) throw {error: "Failure to retrieve friend list."};
            list = list.concat(offlist);
        }
        return list;
    }

    async vrcFriendRequest(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        this.log("Sending friend request to " + vrcuserid + ".");
        return this.vrcpost("user/" + vrcuserid + "/friendRequest");
    }

    async vrcUnfriend(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        this.log("Unfriending " + vrcuserid + ".");
        return this.vrcpost("auth/user/friends/" + vrcuserid, undefined, "DELETE");
    }

    async vrcFriendStatus(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        return this.vrcget("user/" + vrcuserid + "/friendStatus");
    }

    async vrcWorld(worldid, instanceid) {
        if (!this.isValidWorld(worldid)) {error: "Invalid world ID."};
        return this.vrcget("worlds/" + worldid + (instanceid ? "/" + instanceid : ""));
    }

    async vrcAvatar(avatarid) {
        if (!this.isValidAvatar(avatarid)) throw {error: "Invalid avatar ID."};
        return this.vrcget("avatars/" + avatarid);
    }

    async vrcInvite(vrcuserid, worldid, instanceid, message) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        if (!this.isValidWorld(worldid)) throw {error: "Invalid world ID."};
        let location = worldid + (instanceid ? ":" + instanceid : "");
        this.log("Sending invite to " + vrcuserid + " for " + location + ".");
        return this.vrcpost("invite/" + vrcuserid, {
            instanceId: location,
            messageSlot: 0
        });
    }


    async vrcInitialize() {
        await this.vrcMe();  //Login

        let handlers = {
            friendStateChange: null,
            friendLocationChange: null,
            friendAdd: null,
            friendDelete: null,
            friendUpdate: null
        };

        let buildWebsocket = () => {
            //Initialize websocket
            return new Promise((resolve, reject) => {
                let ws = new WebSocket(WEBSOCKET + "?authToken=" + this._auth, {headers: {"User-Agent": HTTP_USER_AGENT}, localAddress: this.param("localAddress")});
                
                let connectionError = (err) => reject(err);

                ws.on('open', () => {
                    this._ws = ws;
                    this.log("Established connection to the websocket.");
                    resolve(handlers);
                    ws.removeListener('error', connectionError);
                });

                let resetPing = () => this._wsping = [0, moment().unix()];

                ws.on('ping', (data) => { resetPing(); ws.pong(data); });
                
                ws.on('pong', (data) => { resetPing(); });

                ws.on('error', connectionError);

                ws.on('message', (data) => {
                    resetPing();
                    let message = JSON.parse(data);
                    try {
                        let content = JSON.parse(message.content);
                        if (handlers.friendStateChange && ["friend-active", "friend-online", "friend-offline"].includes(message.type)) {
                            handlers.friendStateChange(content.userId, message.type.split("-")[1], content.user);
                        }
                        if (handlers.friendLocationChange && message.type == "friend-location") {
                            handlers.friendLocationChange(content.userId, content.user, content.world, content.instance, content.location);
                        }
                        if (handlers.friendAdd && message.type == "friend-add") {
                            handlers.friendAdd(content.userId, content.user);
                        }
                        if (handlers.friendDelete && message.type == "friend-delete") {
                            handlers.friendDelete(content.userId);
                        }
                        if (handlers.friendUpdate && message.type == "friend-update") {
                            handlers.friendUpdate(content.userId, content.user);
                        }
                    } catch (e) {
                        this.log("warn", "Could not parse websocket message: " + message.content);
                    }
                });

                resetPing();
                this._wstimeout = setInterval(() => {
                    if (moment().unix() - this._wsping[1] < 30) return;
                    if (this._wsping[0] > 2) {
                        this._ws.terminate();
                        clearInterval(this._wstimeout);
                        buildWebsocket();
                    } else {
                        this._ws.ping(this._wsping[0]);
                        this._wsping[0] += 1;
                    }
                }, 30000);

            });
        }

        return buildWebsocket();
    }


    //Low level api methods

    setCookies(result) {
        if (result.cookies) {
            for (let cookie of result.cookies) {
                let parts = cookie.split(";")[0].split("=");
                if (parts[0] == "auth") {
                    this._auth = parts[1];
                }
            }
        }
        return result.body;
    }

    handleVrcApiError(e) {
        if (!e.statusCode) {
            if (e.error && e.error.code == "ENOTFOUND") {
                this.log("warn", "DNS lookup failure: " + e.error.hostname);
            } else {
                //Unexpected error
                this.log("error", JSON.stringify(e));
            }
            throw e;
        } else {
            if (e.statusCode == 502 || e.statusCode == 504) {
                this.log("warn", "Oh no, gateway errors (" + e.statusCode + ")...");
            }
            if (e.statusCode != 401) {
                throw e;
            }
        }
    }

    async rateDelay(promise) {
        let result = await promise;
        return new Promise((resolve, reject) => {
            setTimeout(function() { 
                resolve(result);
             }.bind(this), RATE_DELAY);
        });
    }

    async vrcget(path) {
        if (!path || !NO_AUTH.includes(path) && !this._config) return null;
        let options = {headers: {
            Cookie: [],
            "User-Agent": HTTP_USER_AGENT
        }, returnFull: true, localAddress: this.param("localAddress")};

        if (this._config) options.headers.Cookie.push("apiKey=" + this._config.apiKey);
        if (this._auth) options.headers.Cookie.push("auth=" + this._auth);
        else options.auth = this.param("username") + ':' + this.param("password");

        let result;
        try {
            result = await this.jsonget(ENDPOINT + path, options)
        } catch (e) {
            this.handleVrcApiError(e);
            return null;
        }

        if (result.statusCode == 401 && this._auth) {
            //Expired session
            this._auth = null;
            return this.vrcget(path);
        }
        return this.setCookies(result);
    }

    async vrcpost(path, fields, method) {
        if (!path || !this._config) return null;
        let options = {headers: {
            Cookie: [],
            "User-Agent": HTTP_USER_AGENT
        }, returnFull: true, localAddress: this.param("localAddress")};
        if (method) options.method = method;

        if (this._config) options.headers.Cookie.push("apiKey=" + this._config.apiKey);
        if (this._auth) options.headers.Cookie.push("auth=" + this._auth);
        else options.auth = this.param("username") + ':' + this.param("password");

        let result;
        try {
            result = await this.jsonpost(ENDPOINT + path, fields, options);
        } catch (e) {
            this.handleVrcApiError(e);
            return null;
        }
        
        if (result.statusCode == 401 && this._auth) {
            //Expired session
            this._auth = null;
            return this.vrcpost(path, fields, method);
        }
        return this.setCookies(result);
    }


    //Helpers

    dqueue(func) {
        this._dqueue.push(func);
        /*
        let f = __function, l = __line;
        this._dqueue.push(() => {
            console.log(moment().format("HH:mm:ss"), "->", f, l);
            func();
        });
        */
    }

    testEnv(env) {
        return env.name == this.denv.name;
    }

    isValidUser(vrcuserid) {
        return vrcuserid && vrcuserid.match(/^usr_[0-9a-f-]+$/);
    }

    isValidWorld(worldid) {
        return worldid && worldid.match(/^wrld_[0-9a-f-]+$/);
    }

    isValidAvatar(avatarid) {
        return avatarid && avatarid.match(/^avtr_[0-9a-f-]+$/);
    }

    worldFromLocation(location) {
        if (!location) return null;
        let parts = location.split(":");
        if (!this.isValidWorld(parts[0])) return null;
        return parts[0];
    }

    linkFromLocation(location) {
        if (!location) return "";
        let parts = location.split(":");
        let link = "https://vrchat.com/home/launch?worldId=" + parts[0];
        if (parts[1]) link += "&instanceId=" + parts[1];
        return link;
    }

    joinFromLocation(location) {
        if (!location) return "";
        return "https://www.myshelter.net/vrc/" + location;
    }

    instanceIdFromLocation(location) {
        if (!location) return "";
        let parts = location.split(":");
        if (!parts[1]) return "";
        let instparts = parts[1].split("~");
        if (!instparts[0].match(/^[0-9]+$/)) return "";
        return instparts[0];
    }

    instanceFromLocation(location) {
        if (!location) return "";
        let parts = location.split(":");
        if (!parts[1]) return "";
        return parts[1];
    }

    locationFromWorldAndInstance(worldid, instanceid) {
        let loc = worldid;
        if (instanceid) loc += ":" + instanceid;
        return loc;
    }

    isValidLocation(location) {
        if (!location) return false;
        let parts = location.split(":");
        if (!this.isValidWorld(parts[0])) return false;
        if (parts[1]) {
            let instparts = parts[1].split("~");
            if (!instparts[0].match(/^[0-9]+$/)) return false;
        }
        return true;
    }

    processBooleanArg(arg) {
        if (!arg) return undefined;
        if (arg.match(/(on|y|yes|enable|true|1)/i)) return true;
        if (arg.match(/(off|n|no|disable|false|0)/i)) return false;
    }

    trustLevelColor(tags) {
        if (!tags) return [0, 0, 0];
        if (tags.includes("system_trust_veteran")) return [129, 67, 230];
        if (tags.includes("system_trust_trusted")) return [255, 123, 66];
        if (tags.includes("system_trust_known")) return [43, 207, 92];
        if (tags.includes("system_trust_basic")) return [23, 120, 255];
        return [204, 204, 204];
    }

    highestTrustLevel(tags) {
        for (let trust of TRUST_PRECEDENCE) {
            if (tags.includes(trust)) return trust;
        }
        return null;
    }

    trustLevelIcon(trust) {
        if (trust == "system_trust_veteran") return "🟪";
        if (trust == "system_trust_trusted") return "🟧";
        if (trust == "system_trust_known") return "🟩";
        if (trust == "system_trust_basic") return "🟦";
        return "⬜";
    }

    trustLevelLabel(trust) {
        if (trust == "system_trust_veteran") return "Trusted User";
        if (trust == "system_trust_trusted") return "Known User";
        if (trust == "system_trust_known") return "User";
        if (trust == "system_trust_basic") return "New User";
        return "Visitor";
    }

    tagLabels(tags) {
        let labels = [];
        if (tags.includes("admin_moderator")) labels.push("🛡️ VRChat moderator");
        if (tags.includes("system_probable_troll")) labels.push("🚩 Suspected troll");
        if (tags.includes("system_troll")) labels.push("👹 Troll");
        if (tags.includes("system_supporter")) labels.push("➕ VRChat plus");
        if (tags.includes("system_early_adopter")) labels.push("🐈 Early supporter");
        return labels;
    }
    
    idealServerRegion(userid) {
        let utcOffset = null;
        if (this._modTime && userid) {
            utcOffset = this._modTime.getCurrentUtcOffsetByUserid(this.denv, userid);
        }
        if (utcOffset != null && utcOffset <= -300) return "us";
        else if (utcOffset != null && utcOffset > 0 && utcOffset < 300) return "eu";
        else if (utcOffset != null && utcOffset >= 300) return "jp";
        return "use";
    }

    flags(tags, userid) {
        let flags = [];
        let utcOffset = null;
        if (this._modTime && userid) {
            utcOffset = this._modTime.getCurrentUtcOffsetByUserid(this.denv, userid);
        }
        if (tags.includes("language_eng")) {
            if (utcOffset != null && utcOffset <= -240) flags.push("🇺🇸");
            else if (utcOffset != null && utcOffset >= 480 && utcOffset <= 660) flags.push("🇦🇺");
            else if (utcOffset != null && utcOffset >= 720) flags.push("🇳🇿");
            else flags.push("🇬🇧");
        }
        if (tags.includes("language_kor")) flags.push("🇰🇷");
        if (tags.includes("language_rus")) flags.push("🇷🇺");
        if (tags.includes("language_spa")) flags.push("🇪🇸");
        if (tags.includes("language_por")) {
            if (utcOffset != null && utcOffset >= -300 && utcOffset <= -120) flags.push("🇧🇷");
            else flags.push("🇵🇹");
        }
        if (tags.includes("language_zho")) flags.push("🇨🇳");
        if (tags.includes("language_deu")) flags.push("🇩🇪");
        if (tags.includes("language_jpn")) flags.push("🇯🇵");
        if (tags.includes("language_fra")) flags.push("🇫🇷");
        if (tags.includes("language_swe")) flags.push("🇸🇪");
        if (tags.includes("language_nld")) flags.push("🇳🇱");
        if (tags.includes("language_pol")) flags.push("🇵🇱");
        if (tags.includes("language_dan")) flags.push("🇩🇰");
        if (tags.includes("language_nor")) flags.push("🇳🇴");
        if (tags.includes("language_ita")) flags.push("🇮🇹");
        if (tags.includes("language_tha")) flags.push("🇹🇭");
        if (tags.includes("language_fin")) flags.push("🇫🇮");
        if (tags.includes("language_hun")) flags.push("🇭🇺");
        if (tags.includes("language_ces")) flags.push("🇨🇿");
        if (tags.includes("language_tur")) flags.push("🇹🇷");
        if (tags.includes("language_ara")) {
            if (utcOffset != null && utcOffset == 180) flags.push("🇸🇦");
            else if (utcOffset != null && utcOffset == 120) flags.push("🇪🇬");
            else flags.push("🇦🇪");
        }
        if (tags.includes("language_ron")) flags.push("🇷🇴");
        if (tags.includes("language_vie")) flags.push("🇻🇳");
        return flags;
    }

    statusLabel(status) {
        let icon = "";
        if (status == "active") icon = "🟢";
        if (status == "join me") icon = "🔵";
        if (status == "ask me") icon ="🟠";
        if (status == "busy") icon = "🔴";
        if (status == "website") icon = "🟣";  //Nonstandard, displays as "Active" on the website with a random status color
        if (status == "offline") icon = "⚪";
        if (icon) icon += " ";

        let label = status;
        if (label == "active") label = "in-world";
        label = label[0].toUpperCase() + label.slice(1);

        return icon + label;
    }

    worldInviteButtons(pinnedmode) {
        let row = new MessageActionRow();
        if (pinnedmode === true || pinnedmode === false) {
            row.addComponents(
                new MessageButton()
                    .setCustomId("pin")
                    .setStyle("PRIMARY")
                    .setEmoji(this.param("pinnedemoji"))
                    .setLabel(pinnedmode ? "Pinned" : "Pin")
                    .setDisabled(pinnedmode)
            );
        }
        row.addComponents(
            new MessageButton()
                .setCustomId("inviteany")
                .setStyle("PRIMARY")
                .setEmoji(this.param("anyemoji"))
                .setLabel("Invite to random"),
            new MessageButton()
                .setCustomId("invitepublic")
                .setStyle("SECONDARY")
                .setEmoji(this.param("publicemoji"))
                .setLabel("Public new"),
            new MessageButton()
                .setCustomId("invitefriendsplus")
                .setStyle("SECONDARY")
                .setEmoji(this.param("friendsplusemoji"))
                .setLabel("Friends+ new"),
            new MessageButton()
                .setCustomId("invitefriends")
                .setStyle("SECONDARY")
                .setEmoji(this.param("friendsemoji"))
                .setLabel("Friends-only new")
        );
        return row;
    }

    userInviteButton() {
        return new MessageActionRow().addComponents(
            new MessageButton()
                .setCustomId("join")
                .setStyle("PRIMARY")
                .setEmoji(this.param("inviteemoji"))
                .setLabel("Join")
        );
    }

    placeholderLocation(location, sneak, defaultcontents) {
        if (location == "offline") return "-";
        if (sneak) return "Being sneaky";
        if (location == "private") return "In private world";
        return defaultcontents || "Processing...";
    }

    generateNonce() {
        return random.hexString(64).toUpperCase();
    }

    generateInstanceId(include, exclude) {
        //The include list can contain type/nonce, but the exclude list shouldn't
        let result;
        if (!exclude) exclude = [];
        do {
            if (include && include.length) {
                let i = Math.floor(random.fraction() * include.length);
                result = include[i];
                include.splice(i, 1); //Prevent infinite loop
            } else {
                result = Math.floor(random.fraction() * 99998) + 1;
            }
        } while (exclude.includes(result));
        return result;
    }

    generateInstanceFor(vrcuserid, type, include, exclude, region) {
        let regionpart = "";
        if (region) {
            regionpart = "~region(" + region + ")";
        }
        if (vrcuserid) {
            if (type == "private" || type == "invite") {
                return this.generateInstanceId(include, exclude) + "~private(" + vrcuserid + ")" + regionpart + "~nonce(" + this.generateNonce() + ")";
            }
            if (type == "invite+") {
                return this.generateInstanceId(include, exclude) + "~private(" + vrcuserid + ")~canRequestInvite" + regionpart + "~nonce(" + this.generateNonce() + ")";
            }
            if (type == "friends") {
                return this.generateInstanceId(include, exclude) + "~friends(" + vrcuserid + ")" + regionpart + "~nonce(" + this.generateNonce() + ")";
            }
            if (type == "hidden" || type == "friends+") {
                return this.generateInstanceId(include, exclude) + "~hidden(" + vrcuserid + ")" + regionpart + "~nonce(" + this.generateNonce() + ")";
            }
        }
        return this.generateInstanceId(include, exclude) + regionpart;
    }

    randomEntry(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = keys.filter(filter);
        if (!keys.length) return null;
        let key = keys[Math.floor(random.fraction() * keys.length)];
        return Object.assign({key: key}, map[key]);
    }

    formatWorldTags(tags) {
        tags = tags || [];
        return tags.filter(tag => tag.match(/^author_tag/)).map(tag => tag.replace(/author_tag_/, "").replace(/_/g, ""));
    }

    embedFieldByName(emb, name) {
        if (!emb || !name) return null;
        for (let field of emb.fields) {
            if (field.name.toLowerCase() == name.toLowerCase()) {
                return field;
            }
        }
        return null;
    }

    matchAgainstFilters(thing, filterstr, tests) {
        //tests = [(thing, filter) => true|false, ...]
        if (!thing || !filterstr || !tests || !tests.length) return false;
        let orfilters = filterstr.toLowerCase().split("|").map(filter => filter.trim());
        for (let orfilter of orfilters) {
            let ofresult = true;
            let andfilters = orfilter.split("&").map(filter => filter.trim());
            for (let andfilter of andfilters) {
                let afresult = false;
                for (let test of tests) {
                    if (test(thing, andfilter)) { afresult = true; break; }  //one valid test validates filter
                }
                if (!afresult) { ofresult = false; break; }  //one failed filter invalidates and section
            }
            if (ofresult) return true;  //one successful and section validates or section
        }
        return false;
    }

}


module.exports = ModVRChat;
