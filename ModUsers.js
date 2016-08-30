/* Module: Users -- Manage "known" user accounts and permission flags. */

var fs = require('fs');
var jsonfile = require('jsonfile');

var environments = null;
var modules = null;
var userdata = [];
var userhandles = {};

var datafile = 'users.data.json';


var modname = "Users";
exports.name = modname;


exports.requiredenvironments = [];
exports.requiredmodules = [];


exports.initialize = function(envs, mods, moduleRequest) {

    //Load parameters

    if (!envs) return false;
    environments = envs;
    modules = mods;
    
    
    //Load data
    
    if (!loadUsers(datafile)) return false;

    
    //Register callbacks
    
    moduleRequest('Commands', function(commands) {
    
        //TODO Add commands
    
    });
    
    return true;
}


// # Module code below this line #


//User account manipulation (new accounts only have a handle)

function loadUsers(datafile) {
    try {
        fs.accessSync(datafile, fs.F_OK);
    } catch (e) {
        jsonfile.writeFile(datafile, []);
    }

    try {
        userdata = jsonfile.readFileSync(datafile);
    } catch (e) {
        return false;
    }
    if (!userdata) userdata = [];
    
    userhandles = {};
    for (var i = 0; i < userdata.length; i++) {
        userhandles[userdata[i].handle] = userdata[i];
    }
    
    return true;
}

function saveUsers(datafile) {
    jsonfile.writeFile(datafile, userdata);
}


function addUser(handle) {
    if (userhandles[handle]) return false;

    var newuser = {
        handle: handle,
        ids: [],
        perms: []
    }
    userdata.push(newuser);
    userhandles[handle] = newuser;
    return true;
}

function delUser(handle) {
    if (!userhandles[handle]) return false;
    
    var i = userdata.findIndex(function(checkuser) {
        return checkuser.handle == handle;
    });
    
    if (i > -1) userdata.splice(i, 1);
    delete userhandles[handle];
    
    return true;
}

function getUser(handle) {
    return userhandles[handle];
}


//User ID manipulation - Identify a user in a specific environment as being the owner of the account. idpattern matches the environment's authorid/targetid.

function addId(handle, env, idpattern) {
    if (!env || !idpattern) return false;
    
    var chuser = getUser(handle);
    if (!chuser) return false;

    if (!chuser.ids.find(function(id) { return id.env == env && id.idpattern == idpattern; })) {
        chuser.ids.push({env: env, idpattern: idpattern});
    }

    return true;
}

function delId(handle, env, idpattern) {
    if (!env) return false;
    
    var chuser = getUser(handle);
    if (!chuser) return false;
    
    for (var i = 0; i < chuser.ids.length; i++) {
        if (chuser.ids[i].env != env) continue;
        if (idpattern && chuser.ids[i].idpattern != idpattern) continue;
        chuser.ids.splice(i, 1);
        i -= 1;
    }
    
    return true;
}

function getIds(handle, env) {
    var chuser = getUser(handle);
    if (!chuser) return [];
    
    if (!env) return chuser.ids;
    
    return chuser.ids.map(function(item) {
        return (item.env == env ? item.idpattern : null);
    }).filter(function(idpattern) {
        return idpattern != null;
    });
}

function isIdHandle(handle, env, id, strict) {
    if (strict) {
        if (!environment[env].idIsSecured || !environment[env].idIsAuthenticated) {
            return false;
        }
    }
    
    var ids = getIds(handle, env);
    
    for (var i = 0; i < ids.length; i++) {
        if (RegExp(ids[i]).match(id)) {
            return true;
        }
    }
    
    return false;
}

function getHandlesById(env, id, strict) {
    var result = [];
    
    for (var i = 0; i < userdata.length; i++) {
        if (isIdHandle(userdata[i].handle, env, id, strict)) {
            result.push(userdata[i].handle);
        }
    }

    return result;
}


//Permission manipulation - A permission is a literal which the user may have or not. Permissions are meaningless unless used by other modules.

function addPerms(handle, perms) {
    if (!perms) return false;
    
    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;
    
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (!chuser.perms.find(function(checkperm) { return checkperm == perm; })) {
            chuser.perms.push(perm);
            changed = true;
        }
    }
    
    if (changed) saveUsers(datafile);
    return true;
}

function delPerms(handle, perms) {
    if (!perms) return false;
    
    var changed = false;
    var chuser = getUser(handle);
    if (!chuser) return false;
    
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        var ind = chuser.perms.findIndex(function(checkperm) { return checkperm == perm; });
        if (ind > -1) {
            chuser.perms.splice(ind, 1);
            changed = true;
        }
    }
    
    if (changed) saveUsers(datafile);
    return true;
}

function getPerms(handle) {
    var checkuser = getUser(handle);
    if (!checkuser) return [];
    return checkuser.perms;
}

function hasAllPerms(handle, perms) {
    var checkuser = getUser(handle);
    if (!checkuser) return false;
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (!checkuser.perms.find(function(checkperm) { return checkperm == perm; })) {
            return false;
        }
    }
    return true;
}

function hasAnyPerm(handle, perms) {
    var checkuser = getUser(handle);
    if (!checkuser) return false;
    for (var i = 0; i < perms.length; i++) {
        var perm = perms[i].toLowerCase();
        if (checkuser.perms.find(function(checkperm) { return checkperm == perm; })) {
            return true;
        }
    }
    return false;
}


//Exports for dependent modules

exports.isIdHandle = isIdHandle;
exports.getHandlesById = getHandlesById;
exports.getPerms = getPerms;
exports.hasAllPerms = hasAllPerms;
exports.hasAnyPerm = hasAnyPerm;

