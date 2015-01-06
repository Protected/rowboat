var irc = require('irc');
var _ = require('underscore');
var C = require('./Commands.js');
var jf = require('jsonfile');
var fs = require('fs');
var megahal = require('jsmegahal');
var sys = require("sys");
var mongoose = require('mongoose');
var config = require('./config');
var argv = require('yargs')
          .default('server','irc.irchighway.net')
          .default('nick','Praecantatio')
          .default('channel','#empire')
          .default('password',null)
          .argv
		  ;

		  
var client = new irc.Client(argv.server, argv.nick, {
    channels: [argv.channel,'#game'],
	userName: 'Prae',
	realName: 'Praecantatio',
	floodProtection: true,
	floodProtectionDelay: 500,
	stripColors: true,
	password: argv.password
});
var commandList = [];
var users = [];

var db = mongoose.connect(config.mongoConnStr);
var Schema = mongoose.Schema;
var PAObj;

//Modules
var modules = [
	{
		name: 'Commands.js',
		exp: undefined,
		
	},{
		name: 'memo.js',
		exp: undefined
	}
];
function loadModules() {
	commandList = [];
	_.each(modules, function(module){
		try{
			if ( module.exp)
				module.exp.onReassemble();
			module.exp = requireUncached('./'+module.name);
			module.exp.setMain(PAObj);
			_.each(module.exp.commandList, function(cmd){
				commandList.push(cmd);
			});
		}catch(ex){
			console.log("[ERR] Loading module '"+module.name+"': "+ ex);
		}
	});
}

//EOModules

var userSchema = new Schema({
	 nick: String
	,host: String
	,permissions: String
});
var User = mongoose.model('User',userSchema);

function loadUsers() {
	User.find({}, function(err, data ){
		if ( err ) {console.dir(err); return ;}
		users = data;
		PAObj.users = users;
		console.log("Users Loaded!");
	});
};
loadUsers();
var loadUsersEvent = setTimeout(loadUsers, 60000);

var mdb = {
	'mongoose': mongoose,
	'db': db,
	'Schema': Schema,
	'User': User
};



//Public Access Object
PAObj = {
	client: client,
	checkForPermission: checkForPermission,
	users: users,
	'mdb': mdb,
	loadUsers: loadUsers
};


//C.setMain(PAObj);
loadModules();

megahal.prototype.save = function() {
		var saveObj = {
			words: this.words,
			quads: this.quads,
			next: this.next,
			prev: this.prev
		};
		jf.writeFileSync('mhal.json',saveObj);
}
megahal.prototype.load = function() {
	try{
		var saveObj = jf.readFileSync('mhal.json');
		var _this = this;
		//this.words = saveObj.words;
		_.each(Object.keys(saveObj.words), function ( key ) {
			_this.words[key] = saveObj.words[key];
		});
		//this.quads = saveObj.quads;
		_.each(Object.keys(saveObj.quads), function ( key ) {
			_this.quads[key] = saveObj.quads[key];
			_this.quads[key].hash = function() {
			  return this.tokens.join(',');
			};
			
		});
		//this.next = saveObj.next;
		_.each(Object.keys(saveObj.next), function ( key ) {
			_this.next[key] = saveObj.next[key];
		});
		//this.prev = saveObj.prev;
		_.each(Object.keys(saveObj.prev), function ( key ) {
			_this.prev[key] = saveObj.prev[key];
		});
	} catch (e) {
		
	}
}

var mhal = new megahal(4);
mhal.load();

var stdin = process.openStdin();

stdin.addListener("data", function(d) {
    // note:  d is an object, and when converted to a string it will
    // end with a linefeed.  so we (rather crudely) account for that  
    // with toString() and then substring() 
	var str = d.toString().substring(0, d.length-1)
	mhal.addMass(str);
	mhal.save();
    console.log("Parsed line");
});


client.addListener('error', function(message) {
    console.log('error: ', message);
});

//Commands
client.addListener('message', function (from, to, message, messageObj) {
    var messageArr = message.split(" ");
	var commandStr = messageArr[0].substring(1);
	
    if ( message.charAt(0) == '+' ) {
		
		if ( commandStr == "reassemble" && checkForPermission(from,messageObj.host,'z') ){
			console.log(from + ' reassembled me!');
			
			loadModules();
			return;
		}
		
		var commandObj = getCommand(commandStr);
		if ( commandObj ){
			try {
				var dest;
				if ( !checkForPermission(from,messageObj.host,commandObj.permission) ){
					client.notice(from,"Access denied. Flag "+commandObj.permission+" is required.");
					return;
				}
				if (  commandObj.minParams && messageArr.length < commandObj.minParams+1 ){
					getCommand("help").func(from,to,from,['+help',commandStr],messageObj);
                    return;
				}

				console.log(from+" issued the command: "+messageArr);
				
				if ( commandObj.dest ){
					switch (commandObj.dest){
						case "source": dest = from; break;
						case "channel": {
							if ( to.charAt(0)=='#' ){
								dest = to;
								break;
							}
							else {
								client.notice(from,"Can't use this command outside a channel.");
								return;
							}
						}
						case "any":
						default: dest = to.charAt(0)=='#'?to:from; break;
					}
				} else {
					dest = to.charAt(0)=='#'?to:from;
				}

				commandObj.func(from,to,dest,messageArr,messageObj);
				//if ( message.length < 2 ) { _helpCmd(from, to, ["+help","names"]); return; }
			}catch(ex){
				console.log(ex);
			}
		}
    } else if ( message.indexOf(argv.nick) > -1 ) {
		var dest = to.charAt(0)=='#'?to:from;
		client.say(dest,mhal.getReplyFromSentence(message));
		
	} else if ( message.charAt(0) == '!') {
		
	} else {
		mhal.addMass(message);
		mhal.save();
	}

});

function getCommand(commandStr){
	return _.find(commandList, function(commandObj) { return commandObj.command.toLowerCase() == commandStr.toLowerCase() });
}

//Reload
function requireUncached(module){
    delete require.cache[require.resolve(module)]
    return require(module)
}

function compareChannelLevels(l1, l2){
	var values = {
		"~" : 20,
		"&" : 15,
		"!" : 10,
		"@" : 5,
		"%" : 4,
		"+" : 3
	};

	var ll1 = l1;
	var y = 0;
	for ( var i=0; i<ll1.length; i++ ){
		var x = 0;
		try {
			x = values[ll1[i]];
		} catch( e ){
			x = 0;
		}
		if ( x > y ) {
			l1 = ll1[i];
			y = x;
		}
	}
	
	var v1;
	try {
		v1 = values[l1];
	} catch( e ){
		v1 = 0;
	}
	var v2;
	try {
		v2 = values[l2];
	} catch( e ){
		v2 = 0;
	}

	return v1 >= v2;
}

function checkForPermission( nick, vhost, permission ){
	if ( users.length == 0 ) return true;
	if (typeof permission === 'undefined') return true;
	var regexVhost = new RegExp(vhost,'i');
	var user = _.find(users, function(usr){ return usr.nick.toLowerCase() == nick.toLowerCase();});
	if ( !user ) return false;
	if ( !user.host.match(regexVhost) ) return false;
	if ( user.permissions.indexOf(permission) > -1 || user.permissions.indexOf('z') > -1) return true;
	return false;
}


