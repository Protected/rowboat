/* Module: DiscordTimeRoles -- A Time addon that sets Discord roles based on timezone offsets. */

const Module = require('../Module.js');

const moment = require('moment');

class ModDiscordTimeRoles extends Module {

    get requiredParams() { return [
        'env',
        'roles'                 //A map of {ROLEID: {MIN, MAX}, ...} where MIN and MAX are timezone offsets in minutes.
    ]; }

    get optionalParams() { return [
        'strict'                //If true, removes incorrect roles on startup.
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Time'
    ]; }

    get denv() {
        return this.env(this.param('env'));
    }


    constructor(name) {
        super('DiscordTimeRoles', name);

        this._params['strict'] = false;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (this.denv.envName != "Discord") return false;


        //Register handlers

        this.denv.on("connected", async () => {

            for (let member of this.denv.server.members.cache.array()) {
                let utcOffset = this.mod("Time").getCurrentUtcOffsetByUserid(this.denv, member.id);
                if (utcOffset === null) continue;
                
                //Modify assignments on startup
                
                this.addAndRemoveRoles(member, utcOffset, this.param("strict"));

            }

        });
        

        //Modify assignments on timezone change

        this.mod("Time").registerTimezoneCallback((env, userid, handle, tzinfo) => {
            if (env.name != this.denv.name) return false;

            this.addAndRemoveRoles(env.server.members.cache.get(userid), moment().tz(tzinfo.name).utcOffset(), true);

        });

        return true;
    }
        
    
    // # Module code below this line #

    addAndRemoveRoles(member, utcOffset, strict) {
        let addroles = [], removeroles = [];
        for (let roleid in this.param("roles")) {
            let roleconf = this.param("roles")[roleid];
            if (roleconf.max && utcOffset > roleconf.max || roleconf.min && utcOffset < roleconf.min) {
                if (member.roles.cache.get(roleid)) {
                    removeroles.push(roleid);
                }
            } else {
                if (!member.roles.cache.get(roleid)) {
                    addroles.push(roleid);
                }
            }
        }

        let doaddroles = Promise.resolve();
        if (addroles.length) {
            doaddroles = member.roles.add(addroles, "Adding role" + (addroles.length != 1 ? "s" : "") + " based on timezone rules.");
        }
        
        if (strict && removeroles.length) {
            //Circumventing discord.js bug
            doaddroles.then(() => member.roles.remove(removeroles, "Removing role" + (removeroles.length != 1 ? "s" : "") + " based on timezone rules."));
        }
    }


}


module.exports = ModDiscordTimeRoles;
