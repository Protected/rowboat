/* Module: BridgeSimple -- This module was designed to bridge a pair of single channels in single environments without any style or mention conversions. */

const Module = require('./Module.js');

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
        'tagChannel',           //Prepend each message with the name of the source channel
        'oneWay'                //Set to 'A' if only environment A can send messages, or 'B' if only B can send messages
    ]; }

    constructor(name) {
        super('BridgeSimple', name);
        
        this._params['tagEnvironment'] = false;
        this._params['tagChannel'] = false;
        this._params['oneWay'] = null;
    }


    get envA() {
        return this.env(this.param('envA'));
    }
    
    get envB() {
        return this.env(this.param('envB'));
    }
    

    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        
        //Register callbacks
        
        this.envA.on('message', this.onMessage, this);
        if (this.envA.name != this.envB.name) {
            this.envB.on('message', this.onMessage, this);
        }
        
        return true;
    }


    // # Module code below this line #


    //Event handler


    onMessage(env, type, message, authorid, channelid, rawobject) {
        if (type != "action" && type != "regular") return;
        
        let targetenv = null;
        let targetchan = null;
        
        if (env.name == this.param('envA')) {
            if (!this.param('chanA') || channelid == this.param('chanA')) {
                if (this.param('oneWay') == 'B') return;
                targetenv = this.envB;
                targetchan = this.param('chanB');
            }        
        } 
        if (env.name == this.param('envB')) {
            if (!this.param('chanB') || channelid == this.param('chanB')) {
                if (this.param('oneWay') == 'A') return;
                targetenv = this.envA;
                targetchan = this.param('chanA');
             }
        }
        if (!targetenv) return;
        
        let finalmsg = '<' + env.idToDisplayName(authorid) + '> ' + targetenv.applyFormatting(env.normalizeFormatting(message));
        
        if (this.param('tagChannel')) finalmsg = '[' + env.channelIdToDisplayName(channelid) + '] ' + finalmsg;
        if (this.param('tagEnvironment')) finalmsg = '{' + env.name + '} ' + finalmsg;
        
        targetenv.msg(targetchan, finalmsg);
    }
    
    
}


module.exports = ModBridgeSimple;
