/* Module: VRChatFavorites -- Manages a channel for sharing links to VRChat worlds. */

const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const random = require('meteor-random');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';

class ModVRChatFavorites extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env",                  //Discord environment
        "pinnedchan"            //ID of text channel for favorite worlds
    ]; }

    get optionalParams() { return [
        "name",                 //List name override (unique between this module and VRChatPhotos)
        "deleteemoji",          //Emoji for deleting things
        "usewebhook"            //Use a webhook to re-emit links
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands',
        'VRChat'
    ]; }

    get denv() {
        return this.env(this.param('env'));
    }

    get vrchat() {
        return this.mod("VRChat");
    }

    get pinnedchan() {
        return this.denv.server.channels.cache.get(this.param("pinnedchan"));
    }

    constructor(name) {
        super('VRChatFavorites', name);
        
        this._params["name"] = name.toLowerCase();
        this._params["deleteemoji"] = "❌";
        this._params["usewebhook"] = true;

        this._pins = {};  //Map of favorited worlds (transient) {WORLDID: Message, ...}
    }
    

    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //# Register Discord callbacks

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.members.me.id) return;

            //Delete favorites
            if (this.pinnedchan && messageReaction.message.channel.id == this.pinnedchan.id) {

                if (messageReaction.message.partial) await messageReaction.message.fetch();

                if (messageReaction.emoji.name == this.param("deleteemoji")) {
                    let owners = this.extractOwnersFromPin(messageReaction.message);
                    if (owners && owners.find(owner => owner == user.id)) {
                        messageReaction.message.delete();
                    } else {
                        messageReaction.users.remove(user.id);
                    }
                }

            }

        };

        let messageDeleteHandler = (message) => {
        
            for (let worldid in this._pins) {
                if (this._pins[worldid].id == message.id) {
                    delete this._pins[worldid];
                }
            }

        };

        let messageHandler = (env, type, message, authorid, channelid, messageObject) => {
            if (env.name != this.param("env") || type != "regular" || messageObject.webhookId) return;

            if (channelid == this.pinnedchan?.id) {
                //Direct sharing to pinnedchan
                let worldids = this.extractWorldsFromText(message);
                messageObject.delete();

                if (!worldids.length) {
                    this.announce("> " + message.split("\n")[0] + "\n<@" + authorid + "> The <#" + channelid + "> channel is for favorited worlds only!");
                    return true;
                }

                for (let worldid of worldids) {
                    if (this._pins[worldid]) {
                        let worldname = this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("<@" + authorid + "> The world " + worldname + " is already in " + this.param("name") + ".");
                        continue;
                    }

                    this.vrchat.dqueue(function() {
                        this.potentialWorldPin(worldid, true, authorid)
                            .then(result => {
                                if (!result) {
                                    let worldname = this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("<@" + authorid + "> Failed to add the world " + worldname + " to " + this.param("name") + " - does it still exist?");
                                }
                            });
                    }.bind(this));
                }

                return true;
            }
        };

        this.denv.on("connected", async () => {

            this.vrchat.registerInviteSource(this.pinnedchan.id);

            //Prefetch and index favorites

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                let worldid = this.extractWorldFromMessage(message);
                if (!worldid) return;
                this._pins[worldid] = message;
            });

            this.denv.client.on("messageDelete", messageDeleteHandler);
            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
            this.denv.on("message", messageHandler);
        });


        //# Register Commands





        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcany');

        this.mod('Commands').registerCommand(this, 'vrcany ' + this.param("name"), {
            description: "Obtain a random message from the " + this.param("name") + " worlds channel.",
            args: ["filter", true],
            minArgs: 0
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            let filter = undefined;
            if (args.filter.length) {
                let filterarg = args.filter.join(" ");
                let checkonlytags = filterarg.match(/^\[(.*)\]$/);
                if (checkonlytags) filterarg = checkonlytags[1];
                filter = this.pinFilterFromString(filterarg, checkonlytags);
            }

            let message = this.randomPin(filter);
            if (!message) {
                ep.reply("There are no worlds in " + this.param("name") + (args.filter.length ? " matching your search" : "") + "!");
                return true;
            }

            let data = this.extractWorldFromMessage(message, true);
            if (!data) return true;

            ep.reply("**" + data.title + "** - " + this.getPinnedMsgURL(message.id));

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcount');

        this.mod('Commands').registerCommand(this, 'vrcount ' + this.param("name"), {
            description: "Returns the current amount of worlds from the " + this.param("name") + " channel.",
            args: ["filter", true],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let filter = undefined;
            if (args.filter.length) {
                let filterarg = args.filter.join(" ");
                let checkonlytags = filterarg.match(/^\[(.*)\]$/);
                if (checkonlytags) filterarg = checkonlytags[1];
                filter = this.pinFilterFromString(filterarg, checkonlytags);
            }

            let count = this.countPins(filter);
            ep.reply(count);

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcsave');

        this.mod('Commands').registerCommand(this, 'vrcsave ' + this.param("name"), {
            description: "Back up the list of worlds from the " + this.param("name") + " channel.",
            permissions: [PERM_ADMIN],
            type: ["private"]
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            let json = {};

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                let data = this.extractWorldFromMessage(message, true);
                if (!data) return;
                json[data.worldid] = data;
            }, () => {
                ep.reply(new AttachmentBuilder(Buffer.from(JSON.stringify(json, undefined, 4)), {name: this.param("name") + ".json"}));
            });

            return true;
        });


        this.mod('Commands').registerRootExtension(this, 'VRChat', 'vrcfix');

        this.mod('Commands').registerCommand(this, 'vrcfix ' + this.param("name") + ' update', {
            description: "Refresh all processed entries from " + this.param("name") + " (non-destructive).",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {
                let worldid = this.extractWorldFromMessage(message);
                if (!worldid) return;

                let world = await this.getWorld(worldid);
                if (!world) return;

                let emb = null;
                for (let checkembed of message.embeds) {
                    if (checkembed.image) {
                        emb = EmbedBuilder.from(checkembed);
                        break;
                    }
                }
                if (!emb) return;

                let changed = false;

                //Fix basic
                if (emb.data.title != world.name) {
                    emb.setTitle(world.name);
                    changed = true;
                }

                if (emb.data.image?.url != world.imageUrl) {
                    emb.setImage(world.imageUrl);
                    changed = true;
                }


                let body = [];
                body.push(world.description);
                body = body.join("\n\n");
                if (emb.data.description != body) {
                    emb.setDescription(body || null);
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
                        emb.addFields({name: "Tags", value: tagsToDisplay});
                        changed = true;
                    }
                }

                if (changed) {
                    this.vrchat.dqueue(function() {
                        message.edit({embeds: [emb], components: [this.vrchat.worldInviteButtons()]});
                    }.bind(this));
                }

            }, () => {
                ep.reply("Done!");
            });

            ep.reply("Wait...");
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix ' + this.param("name") + ' convert', {
            description: "Extract and remove messages from the " + this.param("name") + " channel (destructive).",
            details: [
                "Note that converted messages are added to the end, so the end result might be in a different order.",
                "May overload the VRChat delay queue while in operation."
            ],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let worldids = [];
            let deleted = 0;
            let pinned = 0;

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {

                let data = this.extractWorldFromMessage(message, true);
                if (data) {
                    worldids.push([data.worldid, data.sharedById]);
                    if (this._pins[data.worldid]) delete this._pins[data.worldid];
                }
                for (worldid of this.extractWorldsFromText(message.content)) {
                    worldids.push([worldid, message.author?.id]);
                }

                this.vrchat.dqueue(function() {
                    message.delete();
                }.bind(this));
                deleted += 1;

            }, () => {
                
                worldids.reverse();
                let promises = [];

                for (let desc of worldids) {
                    let worldid = desc[0], userid = desc[1];
                    if (this._pins[worldid]) {
                        let worldname = this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("The world " + worldname + " is already pinned.");
                        continue;
                    }
    
                    this.vrchat.dqueue(function() {
                        promises.push(this.potentialWorldPin(worldid, true, userid)
                            .then(result => {
                                if (!result) {
                                    let worldname = this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("Failed to add the world " + worldname + " - does it still exist?");
                                } else {
                                    pinned += 1;
                                }
                            }));
                    }.bind(this));
                }

                this.vrchat.dqueue(function() {
                    Promise.all(promises).then(() => {
                        ep.reply("Done! Pinned " + pinned + "/" + worldids.length + "; Deleted " + deleted + " message" + (deleted != 1 ? "s" : ""));
                    });
                }.bind(this));

            });

            ep.reply("Wait...");
            return true;
        });


        this.mod('Commands').registerCommand(this, 'vrcfix ' + this.param("name") + ' removereacts', {
            description: "Remove all reactions from the " + this.param("name") + " channel (blindly).",
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            this.denv.scanEveryMessage(this.pinnedchan, (message) => {
                this.vrchat.dqueue(function() {
                    message.reactions.removeAll();
                }.bind(this));
            }, () => {
                this.vrchat.dqueue(function() {
                    ep.reply("Done!");
                }.bind(this));
            });

            ep.reply("Wait...");

            return true;
        });


        return true;
    };
    
    
    // # Module code below this line #
    

    //VRChat module shortcuts
    
    extractWorldFromMessage(message, verbose) {
        return this.vrchat.extractWorldFromMessage(message, verbose);
    }

    getWorld(worldid, refresh, dontcache) {
        return this.vrchat.getWorld(worldid, refresh, dontcache);
    }

    getCachedWorld(worldid) {
        return this.vrchat.getCachedWorld(worldid);
    }

    announce(msg) {
        return this.vrchat.announce(msg);
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

        let emb = new EmbedBuilder();

        emb.setTitle(world.name);
        emb.setImage(world.imageUrl);
        emb.setURL("https://vrchat.com/home/world/" + worldid);

        emb.data.fields = [];
        let tags = this.formatWorldTags(world.tags);
        if (tags.length) {
            emb.addFields({name: "Tags", value: tags.join(", "), inline: true});
        }

        if (sharedBy) {
            let msgurl = this.vrchat.getPersonMsgURL(userid);
            if (msgurl) sharedBy = "[" + sharedBy + "](" + msgurl + ")";
            emb.addFields({name: "Added by", value: sharedBy, inline: true});
        }

        let body = [];

        body.push(world.description);

        emb.setDescription(body.join("\n\n") || null);

        this._pins[worldid] = true;

        let post;

        if (this.param("usewebhook")) {
            try {
                let member = await this.denv.server.members.fetch(userid);
                let webhook = await this.denv.getWebhook(this.pinnedchan, member);
                post = webhook.send({embeds: [emb], components: [this.vrchat.worldInviteButtons()]});
            } catch (e) {}
        }
        if (!post) {
            post = this.pinnedchan.send({embeds: [emb], components: [this.vrchat.worldInviteButtons()]});
        }

        return post.then(newmessage => {
                this._pins[worldid] = newmessage;
                return true;
            });
    }

    isWorldPinned(worldid) {
        return !!this._pins[worldid];
    }


    //Messages with favorites

    extractOwnersFromPin(message) {
        if (!message) return null;

        let emb = null;
        if (message.embeds?.length) {
            emb = message.embeds[0];
        }
        if (!emb) return null;
        let results = [];
        for (let field of emb.fields) {
            if (field.name.match(/^added by$/i)) {
                let extrs = field.value.match(/\[[^\]]+\]\(https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/([0-9]+)\)/);
                if (extrs) {
                    let person = this.vrchat.findPersonByMsg(extrs[1]);
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

    countPins(makefilter) {
        return this.countEntries(this._pins, makefilter ? makefilter(this._pins) : undefined);
    }

    pinFilterFromString(filterarg, checkonlytags) {
        return pins => worldid => {
            let data = this.extractWorldFromMessage(pins[worldid], true);
            let filters = [
                (data, filter) => {
                    if (data.tags) {
                        for (let tag of data.tags) {
                            if (tag == filter) return true;
                        }
                    }
                }
            ];
            if (!checkonlytags) {
                filters.push((data, filter) => data.title?.toLowerCase().indexOf(filter) > -1);
                filters.push((data, filter) => data.description?.toLowerCase().indexOf(filter) > -1);
                filters.push((data, filter) => data.sharedBy?.toLowerCase().indexOf(filter) > -1);
            }
            return this.matchAgainstFilters(data, filterarg, filters);
        }
    }


    //Helpers

    randomEntry(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = keys.filter(filter);
        if (!keys.length) return null;
        let key = keys[Math.floor(random.fraction() * keys.length)];
        return Object.assign({key: key}, map[key]);
    }

    countEntries(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = keys.filter(filter);
        return keys.length;
    }

    formatWorldTags(tags) {
        tags = tags || [];
        return tags.filter(tag => tag.match(/^author_tag/)).map(tag => tag.replace(/author_tag_/, "").replace(/_/g, ""));
    }

    embedFieldByName(emb, name) {
        if (!emb || !emb.data.fields || !name) return null;
        for (let field of emb.data.fields) {
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

    extractWorldsFromText(txt) {
        if (!txt) return [];
        return txt.match(/wrld_[0-9a-f-]+/g) || [];
    }

}


module.exports = ModVRChatFavorites;
