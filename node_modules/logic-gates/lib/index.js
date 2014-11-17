
// 
// Logical gates defined as simple functions
// 

exports.and = function(a, b) {
	return a && b;
};

exports.nand = function(a, b) {
	return ! (a && b);
}

exports.or = function(a, b) {
	return a || b;
};

exports.nor = function(a, b) {
	return ! (a || b);
};

exports.xor = function(a, b) {
	return (! a) != (! b);
};

exports.xnor = function(a, b) {
	return (! a) == (! b);
};

exports.not = function(a) {
	return ! a;
};

exports.not.and  = exports.nand;
exports.not.or   = exports.nor;
exports.not.xor  = exports.xnor;
