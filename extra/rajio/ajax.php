<?php  //Server-side AJAX handlers

define('AJAX_REQUEST', 1);


$ERRORCODES = array(
      1 => "Operation not found."
);


header('Content-type: application/json');

function doNothing($code = 0) {
    global $ERRORCODES;
    die (json_encode(array("r" => false, "errno" => $code, "error" => (isset($ERRORCODES[$code]) ? $ERRORCODES[$code] : "Unknown error"))));
}

if (!isset($_REQUEST["s"])) doNothing(1);

$s = $_REQUEST["s"];
if (!in_array($s, ["library", "misc"])) doNothing(7);

$file = str_replace("/", "", $s) . ".php";
if (!file_exists($file)) doNothing(1);

$result = array();

require($file);
$result["r"] = true;

echo json_encode($result);
