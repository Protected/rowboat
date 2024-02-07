import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import random from 'meteor-random';
import fs from 'fs';
import moment from 'moment';
import jszip from 'jszip';

import Behavior from '../src/Behavior.js';

const FAVV_PATH = 'extra/vrchatfavorites/favv.html';

const FILTER_TAGS = /^\[(.*)\]$/i;
const FILTER_PLATFORMS = /^\<(.*)\>$/i;

const OTHERS_OPERATION = /^\{([+&-][A-Za-z0-9_-]+)\}(.*)/;
const OTHERS_UNION = '+';
const OTHERS_INTERSECTION = '&';
const OTHERS_SUBTRACTION = '-';

export default class VRChatFavorites extends Behavior {

    get description() { return "Manages a channel for sharing static links to VRChat worlds"; }

    get params() { return [
        {n: "pinnedchan", d: "ID of text channel for favorite worlds"},
        {n: "listname", d: "List name override (unique between this module and VRChatPhotos); defaults to instance name"},
        {n: "deleteemoji", d: "Emoji for deleting things"},
        {n: "usewebhook", d: "Use a webhook to re-emit links"},
        {n: "otherfavorites", d: "List of names of other instances of this Behavior that can be used in filter operations"}
    ]; }

    get defaults() { return {
        listname: null,
        deleteemoji: "❌",
        usewebhook: true,
        otherfavorites: []
    }; }

    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: "Users",
        Commands: "Commands",
        VRChat: "VRChat"
    }; }

    get isMultiInstanceable() { return true; }

    get denv() {
        return this.env("Discord");
    }

    get vrchat() {
        return this.be("VRChat");
    }

    get pinnedchan() {
        return this.denv.server.channels.cache.get(this.param("pinnedchan"));
    }

    constructor(name) {
        super('VRChatFavorites', name);
        
        this._listName = name;

        this._others = {};  //Maps list names to other favorites instances

        this._pins = {};  //Map of favorited worlds (transient) {WORLDID: Message, ...}
    }
    

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let {beExists, beProxy} = opt;

        if (this.param("listname")) this._listName = this.param("listname");

        //# Setup integration with other instances

        for (let other of this.param("otherfavorites") || []) {
            if (!beExists(other, this.constructor.name)) {
                this.log("error", "Instance for filter operations not found or wrong type:", other);
                return false;
            }
            let otherProxy = beProxy(other);
            otherProxy.listName().then(otherListName => this._others[otherListName.toLowerCase()] = otherProxy);  //Will only resolve when initialized
        }

        //# Register Discord callbacks

        let messageReactionAddHandler = async (messageReaction, user) => {
            if (user.id == this.denv.server.members.me.id) return;

            //Delete favorites
            if (this.pinnedchan && messageReaction.message.channel.id == this.pinnedchan.id) {

                if (messageReaction.message.partial) await messageReaction.message.fetch();

                if (messageReaction.emoji.name == this.param("deleteemoji")) {
                    let owners = await this.extractOwnersFromPin(messageReaction.message);
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

        let messageHandler = async (env, type, message, authorid, channelid, messageObject) => {
            if (type != "regular" || messageObject.webhookId) return;

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
                        let worldname = await this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("<@" + authorid + "> The world " + worldname + " is already in " + this._listName + ".");
                        continue;
                    }

                    this.vrchat.dqueue(function() {
                        this.potentialWorldPin(worldid, true, authorid)
                            .then(async result => {
                                if (!result) {
                                    let worldname = await this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("<@" + authorid + "> Failed to add the world " + worldname + " to " + this._listName + " - does it still exist?");
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

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {
                let worldid = await this.extractWorldFromMessage(message);
                if (!worldid) return;
                this._pins[worldid] = message;
            });

            this.denv.client.on("messageDelete", messageDeleteHandler);
            this.denv.client.on("messageReactionAdd", messageReactionAddHandler);
            this.denv.on("message", messageHandler);
        });


        //# Register Commands

        const permAdmin = this.be("Users").defaultPermAdmin;

        this.be('Commands').registerRootExtension(this, 'VRChat', 'vrcany');

        this.be('Commands').registerCommand(this, 'vrcany ' + this._listName, {
            description: "Obtain a random message from the " + this._listName + " worlds channel.",
            args: ["filter", true],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let filterstring = "", operationmatch;
            if (args.filter.length) {
                filterstring = args.filter.join(" ").trim();
            }

            let pins = this._pins;
            while (!!(operationmatch = filterstring.match(OTHERS_OPERATION))) {
                pins = await this.combinePins(pins, operationmatch[1]);
                if (!pins) {
                    ep.reply("No reference to a list named " + operationmatch[1] + ".");
                    return true;
                }
                filterstring = operationmatch[2].trim();
            }

            let filter = undefined;
            if (filterstring) {
                filter = this.pinFilterFromString(filterstring);
            }

            let message = await this.randomPin(pins, filter);
            if (!message) {
                ep.reply("There are no worlds in " + this._listName + (args.filter.length ? " matching your search" : "") + "!");
                return true;
            }

            let data = await this.extractWorldFromMessage(message, true);
            if (!data) return true;

            ep.reply("**" + data.title + "** - " + this.getPinnedMsgURL(message.id));

            return true;
        });


        this.be('Commands').registerRootExtension(this, 'VRChat', 'vrcount');

        this.be('Commands').registerCommand(this, 'vrcount ' + this._listName, {
            description: "Returns the current amount of worlds from the " + this._listName + " channel.",
            args: ["filter", true],
            minArgs: 0
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let filterstring = "", operationmatch;
            if (args.filter.length) {
                filterstring = args.filter.join(" ").trim();
            }

            let pins = this._pins;
            while (!!(operationmatch = filterstring.match(OTHERS_OPERATION))) {
                pins = await this.combinePins(pins, operationmatch[1]);
                if (!pins) {
                    ep.reply("No reference to a list named " + operationmatch[1] + ".");
                    return true;
                }
                filterstring = operationmatch[2].trim();
            }

            let filter = undefined;
            if (filterstring) {
                filter = this.pinFilterFromString(filterstring);
            }

            let count = await this.countPins(pins, filter);
            ep.reply(count);

            return true;
        });


        this.be('Commands').registerRootExtension(this, 'VRChat', 'vrcsave');

        this.be('Commands').registerCommand(this, 'vrcsave ' + this._listName, {
            description: "Generate a list of worlds for download using the " + this._listName + " cache as a source.",
            details: [
                "The following modes are available:",
                "  json - Send only the favorites list in a machine-readable (json) format.",
                "  favv - Send only the latest version of Favorites Viewer (the filter will be ignored).",
                "  zip - Send a zip archive containing the favorites list and the latest version of FavV.",
                "  embedded (default) - Send a single HTML file with FavV and the favorites list embedded in it."
            ],
            args: ["mode", "filter", true],
            minArgs: 0
        },  async (env, type, userid, channelid, command, args, handle, ep) => {

            let mode = args.mode || "embedded";
            mode = mode.toLowerCase();
            if (mode === "" || mode == "-" || mode == "html") mode = "embedded";
            if (["embedded", "json", "favv", "zip"].indexOf(mode) < 0) {
                ep.reply("Invalid mode. Please use: json, favv, zip or embedded");
                return true;
            }

            if (mode == "favv") {
                this.deliverFavv(ep);
                return true;
            }

            let channel = this.pinnedchan;

            let filterstring = "", operationmatch, originalfilter;
            if (args.filter.length) {
                originalfilter = filterstring = args.filter.join(" ").trim();
            }

            let result = {
                name: this._listName,
                filter: originalfilter,
                requestStart: moment().unix(),
                serverid: channel.guild.id,
                channelid: channel.id,
                channelname: channel.name,
                favorites: []
            }

            let pins = this._pins, usedlists = [];
            while (!!(operationmatch = filterstring.match(OTHERS_OPERATION))) {
                pins = await this.combinePins(pins, operationmatch[1]);
                if (!pins) {
                    ep.reply("No reference to a list named " + operationmatch[1] + ".");
                    return true;
                }
                filterstring = operationmatch[2].trim();
            }

            let filter = undefined;
            if (filterstring) {
                filter = this.pinFilterFromString(filterstring);
            }

            pins = await this.filterAllPins(pins, filter);
            for (let pin of pins) {
                let data = await this.extractWorldFromMessage(pin, true);
                result.favorites.push({
                    wi: data.worldid,
                    wn: data.title,
                    im: data.image?.url,
                    iw: data.image?.width,
                    ih: data.image?.height,
                    de: data.description,
                    tg: data.tags,
                    pl: data.platforms,
                    si: data.sharedById,
                    sn: data.sharedBy
                });
            }

            let fndt = moment.unix(result.requestStart).format("YYYYMMDD_HHmm");
            if (mode == "embedded") {
                this.deliverEmbed(ep, channel.name + "." + fndt + ".html", result);
            } else if (mode == "zip") {
                this.deliverZip(ep, channel.name + "." + fndt, result);
            } else {
                this.deliverDownload(ep, channel.name + "." + fndt + ".json", result);
            }

            return true;
        });


        this.be('Commands').registerRootExtension(this, 'VRChat', 'vrcfix');

        this.be('Commands').registerCommand(this, 'vrcfix ' + this._listName + ' dump', {
            description: "Retrieve the set of worlds from the " + this._listName + " channel and provide it as a JSON attachment.",
            permissions: [permAdmin],
            type: ["private"]
        },  (env, type, userid, channelid, command, args, handle, ep) => {

            let json = {};

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {
                let data = await this.extractWorldFromMessage(message, true);
                if (!data) return;
                json[data.worldid] = data;
            }, async () => {
                ep.reply(new AttachmentBuilder(Buffer.from(JSON.stringify(json, undefined, 4)), {name: this._listName + ".json"}));
            });

            return true;
        });

        this.be('Commands').registerCommand(this, 'vrcfix ' + this._listName + ' update', {
            description: "Refresh all processed entries from " + this._listName + " (only destructive in webhook mode).",
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let updateQueue = [];
            let promises = [];
            let myid = this.denv.server.members.me.id;

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {
                updateQueue.push(async () => {
                    let data = await this.extractWorldFromMessage(message, true);
                    if (!data) return;

                    let worldid = data.worldid;
                
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

                    let addedBy = this.embedFieldByName(emb, "Added by") || this.embedFieldByName(emb, "Pinned by") || this.embedFieldByName(emb, "Shared by");

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
                    let tags = this.formatWorldTags(world.tags);
                    tags = tags.length ? tags.join(", ") : "-";
                    
                    let willchange = true;
                    if (!emb.data.fields[0]) emb.addFields({name: "Tags", value: tags, inline: true});
                    else if (emb.data.fields[0].name != "Tags" || emb.data.fields[0].value != tags) emb.spliceFields(0, 1, {name: "Tags", value: tags, inline: true});
                    else willchange = false;
                    if (willchange) changed = true;

                    //Fix platforms
                    let platforms = await this.vrchat.worldPlatformsAsEmojiField(world);
                    
                    willchange = true;
                    if (!emb.data.fields[1]) emb.addFields({name: "Platforms", value: platforms, inline: true});
                    else if (emb.data.fields[1].name != "Platforms" || emb.data.fields[1].value != platforms) emb.spliceFields(1, 1, {name: "Platforms", value: platforms, inline: true});
                    else willchange = false;
                    if (willchange) changed = true;

                    //Fix added by
                    if (addedBy) {
                        willchange = true;
                        if (!emb.data.fields[2]) emb.addFields({name: "Added by", value: addedBy.value, inline: true});
                        else if (emb.data.fields[2].name != "Added by" || emb.data.fields[2].value != addedBy.value) emb.spliceFields(2, 1, {name: "Added by", value: addedBy.value, inline: true});
                        else willchange = false;
                        if (willchange) changed = true;
                    }

                    if (changed) {
                        this.vrchat.dqueue(async function() {
                            if (message.author?.id == myid) {
                                promises.push(message.edit({embeds: [emb], components: [await this.vrchat.worldInviteButtons()]}));
                            } else {
                                promises.push(this.potentialWorldPin(worldid, true, data.sharedById, true)
                                    .then(async result => {
                                        if (result) {
                                            message.delete()
                                        } else {
                                            let worldname = await this.getCachedWorld(worldid)?.name || worldid;
                                            this.announce("Failed to add the world " + worldname + " to " + this._listName + " - does it still exist?");
                                        }
                                    })
                                );
                            }
                        }.bind(this));
                    }
                });

            }, async () => {

                let oneMoreUpdate = async () => {
                    let update = updateQueue.pop();
                    await update();
                    if (updateQueue.length) {
                        setTimeout(() => oneMoreUpdate(), 2000);  //Slow queue for the sake of the VRChat API.
                    } else {
                        ep.reply("Fetching and processing completed.");
                        Promise.allSettled(promises).then(() => {
                            ep.reply("Done updating " + promises.length + " message(s)!");
                        });
                    }
                }
                
                if (updateQueue.length) {
                    oneMoreUpdate();
                } else {
                    ep.reply("Found no applicable messages.");
                }
                
            });

            ep.reply("Wait...");
            return true;
        });


        this.be('Commands').registerCommand(this, 'vrcfix ' + this._listName + ' convert', {
            description: "Extract and remove messages from the " + this._listName + " channel (destructive).",
            details: [
                "Note that converted messages are added to the end, so the end result might be in a different order.",
                "May overload the VRChat delay queue while in operation."
            ],
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let worldids = [];
            let deleted = 0;
            let pinned = 0;

            this.denv.scanEveryMessage(this.pinnedchan, async (message) => {

                let data = await this.extractWorldFromMessage(message, true);
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

            }, async () => {
                
                worldids.reverse();
                let promises = [];

                for (let desc of worldids) {
                    let worldid = desc[0], userid = desc[1];
                    if (this._pins[worldid]) {
                        let worldname = await this.getCachedWorld(worldid)?.name || worldid;
                        this.announce("The world " + worldname + " is already pinned.");
                        continue;
                    }
    
                    this.vrchat.dqueue(function() {
                        promises.push(this.potentialWorldPin(worldid, true, userid)
                            .then(async result => {
                                if (!result) {
                                    let worldname = await this.getCachedWorld(worldid)?.name || worldid;
                                    this.announce("Failed to add the world " + worldname + " to " + this._listName + " - does it still exist?");
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


        this.be('Commands').registerCommand(this, 'vrcfix ' + this._listName + ' removereacts', {
            description: "Remove all reactions from the " + this._listName + " channel (blindly).",
            permissions: [permAdmin]
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
    

    listName() {
        return this._listName;
    }

    pins() {
        return this._pins;
    }


    //VRChat module shortcuts (async)
    
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

    async potentialWorldPin(message, byid, userid, replacing) {

        let worldid;
        if (byid) {
            worldid = message;
        } else {
            worldid = await this.extractWorldFromMessage(message);
        }
        if (!worldid) return false;
        if (this._pins[worldid] && !replacing) return false;

        let sharedBy = await this.denv.idToDisplayName(userid);

        let world = await this.getCachedWorld(worldid);
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
        emb.addFields({name: "Tags", value: tags.length ? tags.join(", ") : "-", inline: true});

        let platforms = await this.vrchat.worldPlatformsAsEmojiField(world);
        emb.addFields({name: "Platforms", value: platforms, inline: true});

        if (sharedBy) {
            let msgurl = await this.vrchat.getPersonMsgURL(userid);
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
                post = webhook.send({embeds: [emb], components: [await this.vrchat.worldInviteButtons()]});
            } catch (e) {}
        }
        if (!post) {
            post = this.pinnedchan.send({embeds: [emb], components: [await this.vrchat.worldInviteButtons()]});
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

    async extractOwnersFromPin(message) {
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
                    let person = await this.vrchat.findPersonByMsg(extrs[1]);
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

    async randomPin(pins, makefilter) {
        return this.randomEntry(pins, makefilter ? await makefilter(pins) : undefined);
    }

    async countPins(pins, makefilter) {
        return this.countEntries(pins, makefilter ? await makefilter(pins) : undefined);
    }

    async filterAllPins(pins, makefilter) {
        return this.filterEntries(pins, makefilter ? await makefilter(pins) : undefined);
    }

    async combinePins(pins, commandstr) {
        if (!pins || typeof(pins) != "object") return null;
        let mode = null;
        if (commandstr.substring(0, 1) == OTHERS_UNION) mode = 1;
        if (commandstr.substring(0, 1) == OTHERS_INTERSECTION) mode = 2;
        if (commandstr.substring(0, 1) == OTHERS_SUBTRACTION) mode = 3;
        if (!mode) return null;
        let listname = commandstr.substring(1).toLowerCase();
        if (!this._others[listname]) return null;
        let result = {};
        let otherpins = await this._others[listname].pins();
        if (mode == 1) {
            result = Object.assign({}, pins);
            for (let worldid in otherpins) {
                if (!result[worldid]) {
                    result[worldid] = otherpins[worldid];
                }
            }
        }
        if (mode == 2) {
            for (let worldid in pins) {
                if (otherpins[worldid]) {
                    result[worldid] = pins[worldid];
                }
            }
        }
        if (mode == 3) {
            for (let worldid in pins) {
                if (!otherpins[worldid]) {
                    result[worldid] = pins[worldid];
                }
            }
        }
        return result;
    }

    isFilterExpr(str, regexes) {
        if (!Array.isArray(regexes)) regexes = [regexes];
        return regexes.reduce((acc, regex) => acc || str.match(regex), false);
    }

    removeFilterExpr(str, regexes) {
        if (!Array.isArray(regexes)) regexes = [regexes];
        for (let regex of regexes) {
            let check = str.match(regex);
            if (check) return check[1];
        }
        return str;
    }

    pinFilterFromString(filterarg) {
        return pins => async worldid => {
            let data = await this.extractWorldFromMessage(pins[worldid], true);
            let filters = [];
            filters.push((data, filter) => {
                if (this.isFilterExpr(filter, FILTER_PLATFORMS)) return false;
                filter = this.removeFilterExpr(filter, FILTER_TAGS);
                if (data.tags) return !!data.tags.find(tag => tag == filter);
            });
            filters.push((data, filter) => {
                if (this.isFilterExpr(filter, FILTER_TAGS)) return false;
                filter = this.removeFilterExpr(filter, FILTER_PLATFORMS);
                if (data.platforms) return !!data.platforms.find(plat => plat == filter);
            });
            filters.push((data, filter) => !this.isFilterExpr(filter, [FILTER_TAGS, FILTER_PLATFORMS]) && data.title?.toLowerCase().indexOf(filter) > -1);
            filters.push((data, filter) => !this.isFilterExpr(filter, [FILTER_TAGS, FILTER_PLATFORMS]) && data.description?.toLowerCase().indexOf(filter) > -1);
            filters.push((data, filter) => !this.isFilterExpr(filter, [FILTER_TAGS, FILTER_PLATFORMS]) && data.sharedBy?.toLowerCase().indexOf(filter) > -1);
            return this.matchAgainstFilters(data, filterarg, filters);
        }
    }

    //Save delivery

    async getFavv() {
        return new Promise((resolve, reject) => {
            fs.readFile(FAVV_PATH, {encoding: 'utf-8'}, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    deliverDownload(ep, filename, json) {
        ep.reply(new AttachmentBuilder(Buffer.from(JSON.stringify(json)), {name: filename}));
    }

    deliverFavv(ep) {
        this.getFavv().then((contents) => ep.reply(new AttachmentBuilder(Buffer.from(contents), {name: "favv.html"})));
    }

    deliverEmbed(ep, filename, json) {
        this.getFavv().then((favv) => ep.reply(
            new AttachmentBuilder(Buffer.from(
                favv.replace(/let predump = null; \/\*FAVORITES DUMP STRING\*\//, "let predump = decodeURIComponent('"
                    + encodeURIComponent(JSON.stringify(json)).replace(/(')/g, "\\$1")
                    + "'); /*FAVORITES DUMP STRING*/"
                )
            ), {name: filename})
        ));
    }

    deliverZip(ep, filename, json) {
        let zip = new jszip();
        this.getFavv().then((favv) => {
            zip.file("favv.html", favv);
            zip.file(filename + ".json", JSON.stringify(json));
            zip.generateAsync({
                type:'nodebuffer',
                compression: 'DEFLATE',
            }).then((buffer) => {
                ep.reply(new AttachmentBuilder(buffer, {name: filename + ".zip"}));
            });
        });
    }


    //Helpers

    async asyncFilter(list, filter) {
        let tests = [], results = {};
        for (let item of list) {
            tests.push(filter(item).then(result => results[item] = result));
        }
        await Promise.all(tests);
        let filtered = [];
        for (let item of list) {
            if (results[item]) {
                filtered.push(item);
            }
        }
        return filtered;
    }

    async randomEntry(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = await this.asyncFilter(keys, filter);
        if (!keys.length) return null;
        let key = keys[Math.floor(random.fraction() * keys.length)];
        return Object.assign({key: key}, map[key]);
    }

    async countEntries(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = await this.asyncFilter(keys, filter);
        return keys.length;
    }

    async filterEntries(map, filter) {
        let keys = Object.keys(map);
        if (filter) keys = await this.asyncFilter(keys, filter);
        let result = [];
        for (let key of keys) {
            result.push(Object.assign({key: key}, map[key]));
        }
        return result;
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
