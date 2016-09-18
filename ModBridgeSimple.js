/* Module: BridgeSimple -- This module was designed to bridge a pair of single channels in single environments without any style or mention conversions. */

var Module = require('./Module.js');

class ModBridgeSimple extends Module {


    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        'envA',                 //Name of the environment A
        'envB'                  //Name of the environment B
    ]; }
    
    get optionalParams() { return [
        'chanA',                //Name of a channel in the environment A
        'chanB',                //Name of a channel in the environment B
        'tagEnvironment',       //Prepend each message with the name of the source environment
        'tagChannel'            //Prepend each message with the name of the source channel
    ]; }

    constructor(name) {
        super('BridgeSimple', name);
        
        this._params['tagEnvironment'] = false;
        this._params['tagChannel'] = false;
    }


    get envA() {
        return this.env(this.param('envA'));
    }
    
    get envB() {
        return this.env(this.param('envB'));
    }
    

    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
        
        
        //Register callbacks
        
        this.envA.registerOnMessage(this.onMessage, this);
        this.envB.registerOnMessage(this.onMessage, this);
        
        return true;
    }


    // # Module code below this line #


    //Event handler


    onMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "action" && type != "regular") return;
        
        var targetenv = null;
        var targetchan = null;
        
        if (env.name == this.param('envA')) {
            if (this.param('chanA') && channelid != this.param('chanA')) return;
            
            targetenv = this.envB;
            targetchan = this.param('chanB');
            
        } else if (env.name == this.param('envB')) {
            if (this.param('chanB') && channelid != this.param('chanB')) return;
        
            targetenv = this.envA;
            targetchan = this.param('chanA');
        
        } else return;
        
        var finalmsg = '<' + env.idToDisplayName(authorid) + '> ' + message;
        
        if (this.param('tagChannel')) finalmsg = '[' + env.channelIdToDisplayName(channelid) + '] ' + finalmsg;
        if (this.param('tagEnvironment')) finalmsg = '{' + env.name + '} ' + finalmsg;
        
        targetenv.msg(targetchan, finalmsg);
    }
    
    
}


module.exports = ModBridgeSimple;
