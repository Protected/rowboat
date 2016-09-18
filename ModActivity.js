/* Module: Activity -- Commands for checking a user's most recent activity/presence. */

var Module = require('./Module.js');
var fs = require('fs');
var jsonfile = require('jsonfile');
var moment = require('moment');

class ModActivity extends Module {


    get optionalParams() { return [
        'datafile',
        'permissionSeen',
        'permissionLast'
    ]; }
    
    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Activity', name);
        
        this._params['datafile'] = 'users.data.json';
        
        this._activitydata = {};
    }


    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;
       
        //Load data
        
        if (!this.loadActivity()) return false;
        
        //TODO Save timer
        

        //Register callbacks
        
        //TODO Listeners
        //TODO Commands
        
        return true;
    }
    
    
    // # Module code below this line #


    //Activity file manipulation

    loadActivity() {
        var datafile = this.param('datafile');
     
        try {
            fs.accessSync(datafile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFile(datafile, {});
        }

        try {
            this._activitydata = jsonfile.readFileSync(datafile);
        } catch (e) {
            return false;
        }
        if (!this._activitydata) this._activitydata = {};
        
        return true;
    }

    saveActivity() {
        var datafile = this.param('datafile');
        
        jsonfile.writeFile(datafile, this._activitydata);
    }
    
    
    //Event handlers
    
    //TODO
    
}


module.exports = ModActivity;
