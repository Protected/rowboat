var _ = require('underscore');

var PA = null;
var mdb = null;
var TDPlayer = null;
var TDShip = null;
var TDPlayerShip = null;
var TDSystem = null;
var TDItem = null;

var tickTimer = null;

var commandList = [{
    command: "join",
    func: _joinCmd,
    help: "Joins the game: The Deeps",
    dest: "any",
},{
    command: "tdcommands",
    func: _tdCommandsCmd,
    help: "List the commands relative to The Deeps",
    dest: "any",
},{
	command: "stats",
	func: _statsCmd,
	help: "Gives stats of the player in The Deeps",
	dest: "any",
},{
	command: "warp",
	func: _warpCmd,
	help: "Warps to another system in The Deeps",
	dest: "any",
},{
	command: "mine",
	func: _mineCmd,
	help: "Mines in the System you are in.",
	dest: "any",
},{
	command: "deval",
	func: _devalCmd,
	help: "Runs an eval in the deep scope.",
	dest: "any",
	permission: "z",
},{
	command: "tda-ship",
	func: _tdaShipCmd,
	help: "TDA - Changes player ship.",
	syntax: "+tda-ship <player> <ship>",
	dest: "any",
	permission: "d",
	minParams: 2,
},{
	command: "tda-warp",
	func: _tdaWarpCmd,
	help: "TDA - Changes player ship.",
	syntax: "+tda-warp <player> <system>",
	dest: "any",
	permission: "d",
	minParams: 2,
}];


var Players = [];
var PlayerShips = [];
var Ships = [];
var Systems = [];

function setMain(mains){
	PA = mains;
	mdb = PA.mdb;
	var Schema = mdb.Schema;
	var ObjectId = mdb.Schema.ObjectId;
	
	function modelExists( name ) {
		try { 
			var m = mdb.mongoose.model(name);
			if ( m ) return true;
			return false;
		} catch (ex){
			return false;
		}
	}
	
	tickTimer = setInterval( doTick , 1000*60*15 );
	function doTick(){
		if ( TDPlayerShip && TDShip ){
			TDPlayerShip.find({}).populate('Ship').exec(updateAllCapacitors);
			function updateAllCapacitors(err, plShips){
				if ( plShips && plShips.length > 0){
					_.each(plShips, function(plShip){
						plShip.Capacitor += plShip.Ship.CapacitorRecharge;
						if ( plShip.Capacitor > plShip.Ship.MaxCapacitor )
							plShip.Capacitor = plShip.Ship.MaxCapacitor;
						plShip.save(function(){});
					});
					console.log("[TheDeep] Tick!");
					loadPlayers();
				}				
			}
		}
	}
	
	
	try{
		
		var tdShipSchema = new Schema({
			Name: String,
			MaxHP: Number,
			MaxShields: Number,
			MaxFirepower: Number,
			MaxCargo: Number,
			MaxCapacitor: Number,
			CapacitorRecharge:Number,
			Price: Number,
		});
		
		var tdItemSchema = new Schema({
			Name: String,
			Type: Number,
			SellWorth: Number,
			Size: Number,
		});
		
		var tdPlayerShipSchema = new Schema({
			Ship: {type: ObjectId, ref: 'TDShip'},
			HP: Number,
			Shields: Number,
			Cargo: { type: Array, "default": [] },
			Capacitor: Number,
		});
		
		var tdSystemSchema = new Schema ({
			Name: String,
			Security: Number,
			Exits: { type: Array, "default": [] },
			Asteroids: { type: Array, "default": [] },
			PirateDrops: { type: Array, "default": [] },
		});
	
		var tdPlayerSchema = new Schema({
			User: String,
			VHost: String,
			Money: Number,
			Ship: { type: ObjectId, ref: 'TDPlayerShip' },
			Location: { type: ObjectId, ref: 'TDSystem' },
		});
		
		if ( !modelExists('TDPlayer') ){
			TDPlayer = mdb.mongoose.model('TDPlayer',tdPlayerSchema);
		} else {
			TDPlayer = mdb.mongoose.model('TDPlayer');
		}
		if ( !modelExists('TDShip') ){
			TDShip = mdb.mongoose.model('TDShip',tdShipSchema);
		}else {
			TDShip = mdb.mongoose.model('TDShip');
		}
		if ( !modelExists('TDPlayerShip') ){
			TDPlayerShip = mdb.mongoose.model('TDPlayerShip',tdPlayerShipSchema);
		}else {
			TDPlayerShip = mdb.mongoose.model('TDPlayerShip');
		}
		if ( !modelExists('TDSystem') ){
			TDSystem = mdb.mongoose.model('TDSystem',tdSystemSchema);
		}else {
			TDSystem = mdb.mongoose.model('TDSystem');
		}
		if ( !modelExists('TDItem') ){
			TDItem = mdb.mongoose.model('TDItem',tdItemSchema);
		}else {
			TDItem = mdb.mongoose.model('TDItem');
		}
		
		//Ships
		TDShip.findOne( {Name: 'Imp'} , function(err, data) {
			if ( err || !data || data.length == 0 ) {
				var Imp = new TDShip({
					Name: 'Imp',
					MaxHP: 100,
					MaxShields: 200,
					MaxFirepower: 50,
					MaxCargo: 200,
					MaxCapacitor: 200,
					CapacitorRecharge: 25,
					Price: 3000,
				});
				Imp.save(function(err,aff){});
			}
		});
		TDShip.findOne( {Name: 'Fatalis'} , function(err, data) {
			if ( err || !data || data.length == 0 ) {
				var Fatalis = new TDShip({
					Name: 'Fatalis',
					MaxHP: 6E10,
					MaxShields: 6E10,
					MaxFirepower: 6E10,
					MaxCargo: 6E10,
					MaxCapacitor: 6E10,
					CapacitorRecharge: 6E10,
					Price: 9E40,
				});
				Fatalis.save(function(err,aff){});
			}
		});
		createSystems();
		setTimeout(loadSystems,5000);
		setTimeout(loadPlayers,5000);
		
	} catch( ex ) {
		console.log(ex);/*
		TDPlayer = mdb.mongoose.model('TDPlayer');
		TDShip = mdb.mongoose.model('TDShip');
		TDPlayerShip = mdb.mongoose.model('TDPlayerShip');
		TDSystem = mdb.mongoose.model('TDSystem');
		TDItem = mdb.mongoose.model('TDItem');
		*/
	}
	
}

function onReassemble(){
	if ( tickTimer ) {
		clearInterval(tickTimer);
	}
}

exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;

function randomIntInc (low, high) {
    return Math.floor(Math.random() * (high - low + 1) + low);
}

function createSystems(){
	//Systems
	var Sys = {};
	var Pre = [
				{ Name: 'Sanctuary', Security: 1},
				{ Name: 'Valgrind', Security: 0.9},
				{ Name: 'Elysium', Security: 0.9},
				{ Name: 'Gyrth', Security: 0.6},
				{ Name: 'Hjoldfadir', Security: 0.5},
				{ Name: 'Yishiki', Security: 0.8},
				{ Name: 'Hishin', Security: 0.6},
				{ Name: 'Holloweth', Security: 0.4},
				{ Name: 'Zuldrack', Security: 0.4},
				{ Name: 'Gynth', Security: 0.3},
				{ Name: 'Draek', Security: 0.3},
				{ Name: 'Heide', Security: 0.6},
				{ Name: 'Peide', Security: 0.6},
				{ Name: 'Fishnyr', Security: 0.2},
				{ Name: 'Fashnyr', Security: 0.5},
				{ Name: 'Batatas', Security: 0.4},
				{ Name: 'Cozidas', Security: 0.3},
				{ Name: 'Fritas', Security: 0.3},
				{ Name: 'Mingyang', Security: 0.2},
				{ Name: 'End', Security: 0.1},
				{ Name: 'Beginning', Security: 0.1},
				{ Name: 'Firefrost', Security: 0.0},
	];
	//for(var i=0; i<Pre.length; i++){
	
	function doNewSystem(i){
		var P = Pre[i];
		TDSystem.findOne({Name: P.Name} , function(err,data) {
			if ( err || !data || data.length == 0 ) {
				Sys[P.Name] = new TDSystem({
					Name: P.Name,
					Security: P.Security,
					Exits: [],
					Asteroids: [],
					PirateDrops: [],
				});
				
			} else {
				Sys[P.Name] = data;
			}
			
			if ( !Pre[i+1] ) {
				Sys[P.Name].save(function(err,aff){
					dealExits();
				});
			} else {
				Sys[P.Name].save(function(err,aff){
					doNewSystem(i+1);
				});
			}
		});
	}
	doNewSystem(0);
	
	function dealExits (err, aff){
		//Make Exits
		Sys['Sanctuary'].Exits = [Sys['Valgrind']._id,Sys['Elysium']._id];
		Sys['Valgrind'].Exits = [Sys['Sanctuary']._id,Sys['Yishiki']._id];
		Sys['Elysium'].Exits = [Sys['Sanctuary']._id,Sys['Hjoldfadir']._id,Sys['Gyrth']._id];
		Sys['Gyrth'].Exits = [Sys['Elysium']._id,Sys['Hjoldfadir']._id];
		Sys['Hjoldfadir'].Exits = [Sys['Elysium']._id,Sys['Gyrth']._id];
		Sys['Yishiki'].Exits = [Sys['Valgrind']._id,Sys['Hishin']._id];
		Sys['Hishin'].Exits = [Sys['Holloweth']._id,Sys['Yishiki']._id];
		Sys['Holloweth'].Exits = [Sys['Zuldrack']._id,Sys['Draek']._id,Sys['Hishin']._id];
		Sys['Zuldrack'].Exits = [Sys['Gynth']._id,Sys['Holloweth']._id,Sys['Valgrind']._id];
		Sys['Gynth'].Exits = [Sys['Zuldrack']._id,Sys['Draek']._id,Sys['Fishnyr']._id,Sys['Heide']._id];
		Sys['Draek'].Exits = [Sys['Mingyang']._id,Sys['Holloweth']._id,Sys['Gynth']._id];
		Sys['Heide'].Exits = [Sys['Peide']._id,Sys['Gynth']._id,Sys['Gyrth']._id,Sys['Fashnyr']._id,Sys['Batatas']._id];
		Sys['Peide'].Exits = [Sys['Heide']._id];
		Sys['Fishnyr'].Exits = [Sys['Mingyang']._id,Sys['Gynth']._id];
		Sys['Fashnyr'].Exits = [Sys['Fritas']._id,Sys['Heide']._id];
		Sys['Batatas'].Exits = [Sys['Cozidas']._id,Sys['Fritas']._id,Sys['Heide']._id];
		Sys['Cozidas'].Exits = [Sys['Batatas']._id];
		Sys['Fritas'].Exits = [Sys['Batatas']._id,Sys['Fashnyr']._id];
		Sys['Mingyang'].Exits = [Sys['End']._id,Sys['Fishnyr']._id,Sys['Draek']._id,];
		Sys['End'].Exits = [Sys['Beginning']._id,Sys['Mingyang']._id];
		Sys['Beginning'].Exits = [Sys['End']._id,Sys['Firefrost']._id];
		Sys['Firefrost'].Exits = [Sys['Beginning']._id];
		
		_.each(Pre, function(PP){
			console.log('Saving %s',Sys[PP.Name].Name);
			Sys[PP.Name].save(function(err,aff){});
		});
		/*
		//loadSystems();
		*/
	}
	
}

function loadSystems(){
	TDSystem.find({}).exec( loadSystemsIntoGlobal );
	
	function loadSystemsIntoGlobal(err, data){
		Systems = [];
		_.each(data,function(system){
			Systems.push(system.toObject());
		});
	}
}

function loadPlayers(){
	
	TDPlayer.find({}).exec( loadPlayersIntoGlobal );
	
	
	function loadPlayersIntoGlobal(err, data) {
		Players = [];
		_.each(data,function(player){
			var Loc = _.find(Systems, function(sys){
				return sys._id.equals(player.Location);
			});
			var playerObj = player.toObject();
			if ( Loc ) playerObj.Location = Loc;
			Players.push(playerObj);
		});
		TDShip.find({}).exec( loadShipsIntoGlobal );
	}
	function loadShipsIntoGlobal(err, data) {
		Ships = [];
		_.each(data, function(ship){
			Ships.push(ship.toObject());
		});
		TDPlayerShip.find({}).exec( loadPlayerShipsIntoGlobal );
	}
	function loadPlayerShipsIntoGlobal(err, data) {
		PlayerShips = [];
		_.each(data, function(plShip){
			PlayerShips.push(plShip.toObject());
		});
		
		for (var i=0; i<Players.length; i++){
			var shipOf = null;
			for (var j=0; j<PlayerShips.length; j++){
				if ( PlayerShips[j]._id.toString() == Players[i].Ship.toString() ){
					shipOf = PlayerShips[j];
					break;
				}
			}
			if ( shipOf ){
				var pl = Players[i];
				pl['Ship'] = shipOf; 
				
				var ship = _.find(Ships, function(ship){
					return ship._id.equals(pl.Ship.Ship);
				});
				if ( ship ) {
					pl.Ship.Ship = ship;
				}
			}
		}
	}
	
}

function _tdCommandsCmd (from, to, dest, message, messageObj) {
	var cmdStrs = [];
	_.each(commandList, function(command){
		if( PA.checkForPermission(from,messageObj.host,command.permission) ) 
			cmdStrs.push(command.command);
	});
	PA.client.say(dest,"Commands for The Deep: "+cmdStrs.join(", "));
}

function _statsCmd (from, to, dest, message, messageObj) {
	var player = _.find(Players, function(pl){
		return pl.User.toLowerCase() == from.toLowerCase();
	});
	if ( !player ){
		PA.client.say(dest,"You're not in the game. Join with +join.");
		return;
	}
	
	PA.client.say(dest,"Player "+player.User+" is flying a "+player.Ship.Ship.Name+" in the system "+player.Location.Name+", has "+player.Ship.Capacitor+ "/"+player.Ship.Ship.MaxCapacitor+" cap and has "+player.Money+"$.");
	
}

function _warpCmd (from, to, dest, message, messageObj) {
	var player = _.find(Players, function(pl){
		return pl.User.toLowerCase() == from.toLowerCase();
	});
	if ( !player ){
		PA.client.say(dest,"You're not in the game. Join with +join.");
		return;
	}
	
	var exits = [];
	_.each(player.Location.Exits, function (exit){
		var exitSys = _.find(Systems, function(sys){
			return sys._id.equals(exit.toString())
		});
		if ( exitSys ) {
			exits.push(exitSys.Name);
		}
	});
	
	if ( message.length < 2 ) {
		PA.client.say(dest,"Exits: "+exits.join(', '));
	} else {
		var destination = message[1];
		
		var destSystem = _.find(exits, function(sys){
			return sys.toLowerCase() == destination.toLowerCase();
		});
		if ( !destSystem ){
			PA.client.say(dest, "There's no exit that matches.");
			return;
		}		
		var chosenSys = _.find(Systems, function(sys){
			return destSystem.toLowerCase() == sys.Name.toLowerCase();
		});
		if ( !chosenSys ){
			PA.client.say(dest, "There's no System that matches.");
			return;
		}
		if ( player.Ship.Capacitor < 25 ){
			PA.client.say(dest, "You don't have enough capacitor energy to make the jump.");
			return;
		}
		
		TDPlayer.findById(player._id, updatePlayer);
		function updatePlayer(err, pl){
			pl.Location = chosenSys._id;
			pl.save(savePlayerAndChangeCap);
		}
		function savePlayerAndChangeCap(err, aff){
			TDPlayerShip.findById(player.Ship._id, changeCap);
		}
		function changeCap(err, plSh){
			plSh.Capacitor -= 25;
			plSh.save(loadPlayers);
			PA.client.say(dest,player.User + " warped into "+destSystem+" successfuly!");
		}
		
	}
	
	
}

function _devalCmd(from,to,dest,message,messageObj ){
	message.splice(0,1);
	var run = message.join(' ');
	try {
		eval(run);
	} catch ( e ) {
		PA.client.say(dest,""+e);
	}

}

function _joinCmd (from, to, dest, message, messageObj) {
	TDPlayer.findOne({User:from}, function(err,data){
		if (data){ PA.client.say(dest,"You're already in the game!") ; loadPlayers(); return;}
		
		TDSystem.findOne({Name: 'Sanctuary'} , function(err,system) {
			if ( err ) return;
			TDShip.findOne( {Name: 'Imp'} , function(err, ship) {
				if ( err ) return;
				
				var playerShip = new TDPlayerShip({
					Ship: ship,
					HP: ship.MaxHP,
					Shields: ship.MaxShields,
					Cargo: [],
					Capacitor: ship.MaxCapacitor,
				});
				playerShip.save(function(){});
				
				var player = new TDPlayer({
					User: from,
					VHost: messageObj.host,
					Money: 1500,
					Ship: playerShip,
					Location: system,
				});
				
				player.save(function(err,aff){
					TDPlayer.findOne({_id:player._id}).populate('Ship').exec(function(err,newPlayer){
						PA.client.say(dest,"You have joined The Deep! Username: "+newPlayer.User+", Money:"+newPlayer.Money+".");
						loadPlayers();
					});
				});
				
			});
		});
		
	});
}

function _tdaShipCmd (from, to, dest, message, messageObj) {
	TDPlayer.findOne({User:message[1]}).exec(checkForPlayer ); 
	
	var tdPlayer;
	var tdShip;
	var tdPlayerShip;
	
	function checkForPlayer(err,player){
		if (!!err || !player){ 
			PA.client.say(dest,"Player not found.");
			return;
		}
		tdPlayer = player;
		TDShip.findOne( {Name: message[2]} , checkForShip);
	}
	function checkForShip(err,ship){
		if (!!err || !ship){
			PA.client.say(dest,"Ship not found.");
			return;
		}
		tdShip = ship;
		TDPlayerShip.findById(tdPlayer.Ship, checkForPlayerShip);
	}
	function checkForPlayerShip(err,plShip){
		if (!!err || !plShip){
			PA.client.say(dest,"Player ship not found.");
			return;
		}
		tdPlayerShip = plShip;
		tdPlayerShip.Ship = tdShip;
		tdPlayerShip.HP = tdShip.MaxHP;
		tdPlayerShip.Shields = tdShip.MaxShields;
		tdPlayerShip.Capacitor = tdShip.MaxCapacitor;
		tdPlayer.save(savePlayer);
		
	}
	function savePlayer( err, aff ){
		tdPlayerShip.save(function(){});
		if(!!err || aff < 1){
			PA.client.say(dest,"Problem saving.");
		}else {
			PA.client.say(dest,"Changed the ship of player "+tdPlayer.User+" into "+tdShip.Name+".");
			loadPlayers();
		}
	}
	
}

function _tdaWarpCmd (from, to, dest, message, messageObj) {
	
}

function _mineCmd (from, to, dest, message, messageObj) {
	var player = _.find(Players, function(pl){
		return pl.User.toLowerCase() == from.toLowerCase();
	});
	if ( !player ){
		PA.client.say(dest,"You're not in the game. Join with +join.");
		return;
	}
	if ( player.Ship.Capacitor < 50 ){
		PA.client.say(dest, "You don't have enough capacitor energy to mine.");
		return;
	}
	
	var improve = 1 - player.Location.Security;
	var width = 40;
	var per = width/2;
	var min = per*improve;
	var chance = randomIntInc(min,min+40);
	
	var multi;
	if ( chance < 20 ) {
		PA.client.say(dest,"You found the remains of a mined asteroid belt.");
		multi = 1;
	} else if ( chance < 40 ){
		PA.client.say(dest,"You found a small asteroid belt with decent ore.");
		multi = 2;
	} else if ( chance < 60 ){
		PA.client.say(dest,"You found an average ore deposit.");
		multi = 4;
	} else if ( chance < 80 ){
		PA.client.say(dest,"You found a generous ore deposit.");
		multi = 8;
	} else {
		PA.client.say(dest,"Jackpot! You've found an asteroid belt with rare minerals.");
		multi = 16;
	}
	var money = 500*multi;
	money += randomIntInc(-250,250);
	
	TDPlayer.findById(player._id, updatePlayer);
	function updatePlayer(err, pl){
		pl.Money += money;
		pl.save(savePlayerAndChangeCap);
	}
	function savePlayerAndChangeCap(err, aff){
		TDPlayerShip.findById(player.Ship._id, changeCap);
	}
	function changeCap(err, plSh){
		plSh.Capacitor -= 50;
		plSh.save(loadPlayers);
		PA.client.say(dest,"Mining it has yielded "+money+"$");
	}
	
}