/* Module: VRChat -- Show information about VRChat users on Discord. */

const moment = require('moment');
const { MessageEmbed } = require('discord.js');

const Module = require('../Module.js');
const { enableConsole } = require('../Logger.js');

const PERM_ADMIN = 'administrator';

const ENDPOINT = "https://api.vrchat.cloud/api/1/";
const NO_AUTH = ["config", "time", "visits"];

const STATUS_ONLINE = ["active", "join me", "ask me"];

class ModVRChat extends Module {

    get requiredParams() { return [
        "env",
        "username",             //VRChat username
        "password",             //VRChat password
    ]; }
    
    get optionalParams() { return [
        "updatefreq",           //How often to request user states and perform updates (s)
        "statuschan",           //ID of text channel for status messages
        "announcechan",         //ID of text channel for announcements
        "expiration",           //How long to stay unfriended before unassigning (h)
        "ddelay",               //Delay between queued actions (ms)
        "offlinetolerance"      //How long to wait before offline announcement (s)
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

    constructor(name) {
        super('VRChat', name);
     
        this._params["updatefreq"] = 120;
        this._params["expiration"] = 48;
        this._params["ddelay"] = 250;
        this._params["offlinetolerance"] = 119;

        this._people = null;  //{USERID: {see registerPerson}, ...}

        this._config = null;  //The full object returned by the "config" API. This API must be called before any other request.
        this._auth = null;  //The auth cookie

        this._timer = null;  //Action timer

        this._dqueue = [];  //Discord update queue
        this._dtimer = null;  //Discord update queue timer
    }
    

    /*
        Worlds/locations
        Timezones
    */

    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        //# Load data

        this._people = this.loadData(undefined, undefined, {quiet: true});
        if (this._people === false) return false;


        //# Initialize VRChat

        //Initialize session

        this.vrcConfig();

        //Log out on shut down

        process.on("SIGINT", () => {
            if (this._auth) {
                this.vrcpost("logout", null, "PUT").then(() => {
                    console.log("Logged out from VRChat.");
                    process.exit();
                });
            } else {
                process.exit();
            }
        });

        
        //# Register callbacks

        let guildMemberRemoveHandler = async (member) => {

            let person = this.getPerson(userid);
            if (this.statuschan && person.msg) {
                let message = this.statuschan.messages.cache.get(person.msg);
                if (message) message.delete({reason: "User has departed the server."});
            }

            this.unregisterPerson(member.id);

        };

        let messageDeleteHandler = (message) => {
        
            for (let userid in this._people) {
                let person = this.getPerson(userid);
                if (person.msg == message.id) {
                   this.clearPersonMsg(userid);
                   break; 
                }
            }
            
        }

        this.denv.on("connected", async () => {

            for (let userid in this._people) {
                let person = this.getPerson(userid);

                let member = this.denv.server.members.cache.get(userid);
                
                if (member) {

                    if (this.statuschan && person.msg) {
                        this.statuschan.messages.fetch(person.msg);
                    }

                } else {

                    if (this.statuschan && person.msg) {
                        this.statuschan.messages.fetch(person.msg)
                            .then(message => message.delete({reason: "User has departed the server."}));
                    }

                    this.unregisterPerson(userid);

                }
            }

            this.denv.client.on("guildMemberRemove", guildMemberRemoveHandler);
            this.denv.client.on("messageDelete", messageDeleteHandler);
        });


        //# Start automation timers

        this._dtimer = setInterval(function () {

            if (!this._dqueue) return;
            let item = this._dqueue.shift();
            if (!item) return;
            item();

        }.bind(this), this.param("ddelay"));


        this._timer = setInterval(async function () {

            let now = moment().unix();

            //Index VRChat friends
            let friends = {}, friendlist = await this.vrcFriendList();
            for (let friend of friendlist) {
                friends[friend.id] = friend;
            }

            let hasStatuschan = !!this.statuschan;

            for (let userid in this._people) {
                
                let person = this.getPerson(userid);

                //Change local person confirmation state
                if (!person.confirmed) {
                    if (friends[person.vrc]) {
                        this.confirmPerson(userid);
                        this.announce("I see you, " + this.denv.idToDisplayName(userid) + "! You're my VRChat friend.");
                    } else {
                        if (now - person.waiting > this.param("expiration") * 3600) {
                            this.unregisterPerson(userid);
                        }
                        continue;
                    }
                } else {
                    let makesure = await this.vrcUser(person.vrc);
                    if (makesure) {
                        if (makesure.state == "active") {
                            makesure.status = "website";
                        } else if (makesure.state == "offline") {
                            makesure.status = "offline";
                        }
                        friends[person.vrc] = makesure;
                    }
                    if (!friends[person.vrc]) {
                        this.unconfirmPerson(userid);
                        this.announce("Uh oh... " + this.denv.idToDisplayName(userid) + " is no longer my friend.");
                        continue;
                    }
                }

                //Update stored avatar picture location
                if (!person.stickypic) {
                    this.updatePic(userid, friends[person.vrc].currentAvatarImageUrl);
                }

                //Synchronize nickname with vrchat username
                if (person.syncnick) {
                    let member = this.denv.server.members.cache.get(userid);
                    if (member && member.displayName.toLowerCase() != friends[person.vrc].displayName.toLowerCase()) {
                        member.setNickname(friends[person.vrc].displayName, "Synchronizing nickname with VRChat.")
                            .catch(e => this.log("error", "Error setting nickname of " + member.displayName + " to " + friends[person.vrc].displayName + ": " + e));
                    }
                }

                //Update saved status and announce changes
                this.updateStatus(userid, friends[person.vrc].status);
                if (person.pendingflip && now - person.latestflip >= this.param("offlinetolerance")) {
                    this.finishStatusUpdate(userid);
                }

                //Bake status embed
                if (hasStatuschan) {
                    this._dqueue.push(function() {
                        this.bakeStatus(userid, friends[person.vrc], now);
                    }.bind(this));
                }

            }


        }.bind(this), this.param("updatefreq") * 1000);


        //# Register commands
        
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

                if (!this.getPerson(targetid)) this.registerPerson(targetid, {vrc: data.id});

                if (!data.isFriend) {
                    let fstatus = await this.vrcFriendStatus(data.id);
                    if (!fstatus.isFriend && !fstatus.outgoingRequest) {
                        await this.vrcFriendRequest(data.id);
                        ep.reply("VRChat account learned. I've sent you a friend request! Please accept it.");
                    } else if (fstatus.outgoingRequest) {
                        ep.reply("VRChat account learned. Please accept my pending friend request!");
                    }
                } else {
                    this.confirmPerson(userid);
                    ep.reply("VRChat account learned.");
                }

            } catch (e) {
                if (e.statusCode == 404) {
                    ep.reply("VRChat account not found.");
                    return true;
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
        },  (env, type, userid, channelid, command, args, handle, ep) => asscall(env, userid, args.discorduser.join(" "), vrchatuser, ep));


        let unasscall = (env, userid, discorduser, ep) => {

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
                let message = this.statuschan.messages.cache.get(person.msg);
                if (message) message.delete({reason: "User was unassigned."});
            }

            this.unregisterPerson(targetid);
            ep.reply("VRChat account unlearned.");

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
        
      
        return true;
    };


    // # Module code below this line #


    //Manipulate index of known users

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

    registerPerson(userid, fields, keep) {
        let person = {
            vrc: null,                      //VRChat user ID
            msg: null,                      //Status message ID
            confirmed: false,               //Whether the user is confirmed (friended)
            syncnick: true,                 //Whether to automatically change user's nickname to VRChat username
            latestpic: null,                //Latest synced avatar picture
            stickypic: false,               //Whether NOT to sync avatar pictures (keep current)
            lateststatus: null,             //Latest VRChat status (used to detect changes)
            latestflip: null,               //Timestamp of latest flip between online/offline
            pendingflip: false,             //Whether there's a pending unannounced flip
            creation: moment().unix(),      //Timestamp of the creation of the person entry (unchanging)
            waiting: moment().unix()        //Timestamp of the start of the current waiting period for friending
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
        this._people[userid].confirmed = false;
        this._people[userid].waiting = moment().unix();
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
            if (STATUS_ONLINE.indexOf(prev) < 0 && STATUS_ONLINE.indexOf(status) > -1) {
                this._people[userid].latestflip = moment().unix();
                if (this._people[userid].pendingflip) {
                    this._people[userid].pendingflip = false;
                } else {
                    this.announce("**" + this.denv.idToDisplayName(userid) + "** is online!");
                }
            }
            if (STATUS_ONLINE.indexOf(prev) > -1 && STATUS_ONLINE.indexOf(status) < 0) {
                this._people[userid].latestflip = moment().unix();
                this._people[userid].pendingflip = true;
                //Delayed announcement is in timer
            }
        }
        this._people.save();
        return true;
    }

    finishStatusUpdate(userid) {
        this.announce("**" + this.denv.idToDisplayName(userid) + "** is offline.");
        this._people[userid].pendingflip = false;
        this._people.save();
    }

    unregisterPerson(userid) {
        if (!this._people[userid]) return false;
        delete this._people[userid];
        this._people.save();
        return true;
    }


    //Status messages

    bakeStatus(userid, vrcdata, now) {
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

        if (!emb) {
            emb = new MessageEmbed();
        }

        emb.setTitle(vrcdata.displayName);
        emb.setThumbnail(person.latestpic);
        emb.setColor(this.trustLevelColor(vrcdata.tags));
        emb.fields = [];
        emb.addField("Trust", this.trustLevelLabel(vrcdata.tags), true);
        emb.addField("Status", this.statusLabel(vrcdata.status), true);
        emb.addField("Location", "(Coming soon)", true);

        let body = "";
        
        if (vrcdata.statusDescription) body += "*" + vrcdata.statusDescription.trim() + "*\n\n";
        if (vrcdata.bio) body += vrcdata.bio.trim() + "\n\n";
        body += "[Profile](https://vrchat.com/home/user/" + vrcdata.id + ")";

        let taglabels = this.tagLabels(vrcdata.tags).join("\n");
        if (taglabels) body += "\n\n" + taglabels;

        emb.setDescription(body);

        if (vrcdata.last_login && vrcdata.status == "offline" && !person.pendingflip) {
            if (person.latestflip) {
                emb.setFooter("Last seen " + moment.unix(person.latestflip).from(now));
            } else if (vrcdata.last_login) {
                emb.setFooter("Last logged in " + moment(vrcdata.last_login).from(now));
            }
        } else {
            emb.setFooter("");
        }

        if (message) {
            message.edit(emb);
        } else {
            this.statuschan.send({embed: emb, disableMentions: 'all'})
                .then(newmessage => this.setPersonMsg(userid, newmessage));
        }

    }


    announce(msg) {
        let achan = this.announcechan;
        if (!achan || !msg) return false;
        this.denv.msg(achan.id, msg);
        return true;
    }


    //High level api methods

    async vrcConfig() {
        return this.vrcget("config").then(data => this._config = data);
    }

    async vrcTime() {
        return this.vrcget("time");
    }

    async vrcVisits() {
        return this.vrcget("visits");
    }

    async vrcUser(vrcuser) {
        let get;
        if (this.isValidUser(vrcuser)) {
            get = vrcuser;
        } else {
            vrcuser = vrcuser.replace(/(\/|:)/g, "");
            get = vrcuser + "/name";
        }
        return this.vrcget("users/" + get);
    }

    async vrcFriendList(online) {
        let list = [];
        if (online !== false) {
            list = list.concat(await this.vrcget("auth/user/friends/?offline=false"));
        }
        if (online !== true) {
            list = list.concat(await this.vrcget("auth/user/friends/?offline=true"));
        }
        return list;
    }

    async vrcFriendRequest(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        return this.vrcpost("user/" + vrcuserid + "/friendRequest");
    }

    async vrcFriendStatus(vrcuserid) {
        if (!this.isValidUser(vrcuserid)) throw {error: "Invalid user ID."};
        return this.vrcget("user/" + vrcuserid + "/friendStatus");
    }

    async vrcWorld(worldid, instanceid) {
        if (!isValidWorld(worldid)) throw {error: "Invalid world ID."};
        return this.vrcget("worlds/" + worldid + (instanceid ? "/" + instanceid : ""));
    }

    async vrcAvatar(avatarid) {
        if (!this.isValidAvatar(avatarid)) throw {error: "Invalid avatar ID."};
        return this.vrcget("avatars/" + avatarid);
    }


    //Low level api methods

    setCookies(result) {
        for (let cookie of result.cookies) {
            let parts = cookie.split("=");
            if (parts[0] == "auth") {
                this._auth = parts[1];
            }
        }
        return result.body;
    }

    async vrcget(path) {
        if (!path || NO_AUTH.indexOf(path) < 0 && !this._config) return null;
        let options = {headers: {Cookie: []}, returnFull: true};

        if (this._config) options.headers.Cookie.push("apiKey=" + this._config.apiKey);
        if (this._auth) options.headers.Cookie.push("auth=" + this._auth);
        else options.auth = this.param("username") + ':' + this.param("password");

        let result;
        try {
            result = await this.jsonget(ENDPOINT + path, options)
        } catch (e) {
            if (!e.statusCode) {
                //Unexpected error
                this.log("error", e);
            }
            throw e;
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
        let options = {headers: {Cookie: []}, returnFull: true};
        if (method) options.method = method;

        if (this._config) options.headers.Cookie.push("apiKey=" + this._config.apiKey);
        if (this._auth) options.headers.Cookie.push("auth=" + this._auth);
        else options.auth = this.param("username") + ':' + this.param("password");

        let result
        try {
            result = await this.jsonpost(ENDPOINT + path, fields, options)
        } catch (e) {
            if (!e.statusCode) {
                //Unexpected error
                this.log("error", e);
            }
            throw e;
        }
        if (result.statusCode == 401 && this._auth) {
            //Expired session
            this._auth = null;
            return this.vrcpost(path, fields, method);
        }
        return this.setCookies(result);
    }


    //Helpers

    testEnv(env) {
        return env.name == this.denv.name;
    }

    isValidUser(vrcuserid) {
        return vrcuserid && vrcuserid.match(/^usr_[0-9a-f-]+$/);
    }

    isValidWorld(worldid) {
        return worldid && worldid.match(/^wlrd_[0-9a-f-]+$/);
    }

    isValidAvatar(avatarid) {
        return avatarid && avatarid.match(/^avtr_[0-9a-f-]+$/);
    }

    processBooleanArg(arg) {
        if (!arg) return undefined;
        if (arg.match(/(on|y|yes|enable|true|1)/i)) return true;
        if (arg.match(/(off|n|no|disable|false|0)/i)) return false;
    }

    trustLevelColor(tags) {
        if (!tags) return [0, 0, 0];
        if (tags.indexOf("system_trust_veteran") > -1) return [129, 67, 230];
        if (tags.indexOf("system_trust_trusted") > -1) return [255, 123, 66];
        if (tags.indexOf("system_trust_known") > -1) return [43, 207, 92];
        if (tags.indexOf("system_trust_basic") > -1) return [23, 120, 255];
        return [204, 204, 204];
    }

    trustLevelLabel(tags) {
        if (!tags) return "Unknown";
        if (tags.indexOf("system_trust_veteran") > -1) return "Trusted User";
        if (tags.indexOf("system_trust_trusted") > -1) return "Known User";
        if (tags.indexOf("system_trust_known") > -1) return "User";
        if (tags.indexOf("system_trust_basic") > -1) return "New User";
        return "Visitor";
    }

    tagLabels(tags) {
        let labels = [];
        if (tags.indexOf("admin_moderator") > -1) labels.push("🛡️ VRChat moderator");
        if (tags.indexOf("system_legend ") > -1 || tags.indexOf("system_trust_legend ") > -1) labels.push("🌟 Legendary");
        if (tags.indexOf("system_probable_troll") > -1) labels.push("🚩 Suspected troll");
        if (tags.indexOf("system_troll") > -1) labels.push("👹 Troll");
        if (tags.indexOf("system_supporter") > -1) labels.push("➕ VRChat plus");
        if (tags.indexOf("system_early_adopter") > -1) labels.push("🐈 Early supporter");
        return labels;
    }

    statusLabel(status) {
        let icon = "";
        if (status == "active") icon = "🟢";
        if (status == "join me") icon = "🔵";
        if (status == "ask me") icon ="🟠";
        if (status == "busy") icon = "🔴";
        if (status == "website") icon = "🟣";  //Nonstandard, displays as a green "Active" on the website
        if (status == "offline") icon = "⚪";
        if (icon) icon += " ";

        let label = status;
        if (label == "active") label = "in-world";
        label = label[0].toUpperCase() + label.slice(1);

        return icon + label;
    }

}


module.exports = ModVRChat;
