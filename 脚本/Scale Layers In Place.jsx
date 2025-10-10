// Scale Layers In Place Script (Corrected)
// This script will scale all selected layers from their individual centers.

// Check if a document is open
if (app.documents.length > 0) {
  var doc = app.activeDocument;
  var selectedLayers = getSelectedLayers(doc);

  if (selectedLayers.length > 0) {
    var scaleFactor = prompt("请输入缩放百分比 (例如: 50 表示缩小一半，200 表示放大一倍)", 100);
    
    // Convert the input string to a number and proceed if it's valid
    if (scaleFactor && !isNaN(scaleFactor)) {
      scaleFactor = parseFloat(scaleFactor);
      
      // Loop through each selected layer and resize it
      for (var i = 0; i < selectedLayers.length; i++) {
        var layer = selectedLayers[i];
        // The resize method takes percentage values. The third argument is the anchor position.
        // AnchorPosition.MIDDLECENTER means scaling from the center.
        layer.resize(scaleFactor, scaleFactor, AnchorPosition.MIDDLECENTER);
      }
    } else {
      alert("请输入有效的数字！");
    }
  } else {
    alert("请至少选择一个图层！");
  }
} else {
  alert("请先打开一个文档！");
}

// Function to get selected layers
function getSelectedLayers(doc) {
    var selectedLayers = [];
    try {
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID('Dcmn'), charIDToTypeID('Ordn'), charIDToTypeID('Trgt'));
        desc.putReference(charIDToTypeID('null'), ref);
        var result = executeAction(stringIDToTypeID('get'), desc, DialogModes.NO);
        if (result.hasKey(stringIDToTypeID('targetLayers'))) {
            var layersList = result.getList(stringIDToTypeID('targetLayers'));
            for (var i = 0; i < layersList.count; i++) {
                var layerRef = layersList.getReference(i);
                var layerDesc = new ActionDescriptor();
                layerDesc.putReference(charIDToTypeID('null'), layerRef);
                var layerResult = executeAction(stringIDToTypeID('get'), layerDesc, DialogModes.NO);
                var layerID = layerResult.getInteger(stringIDToTypeID('layerID'));
                
                // Function to get layer by ID
                function getLayerByID(id) {
                    var ref = new ActionReference();
                    ref.putIdentifier(charIDToTypeID('Lyr '), id);
                    var desc = executeActionGet(ref);
                    return desc;
                }

                // Make the layer active to add it to the array
                var tempDesc = new ActionDescriptor();
                var tempRef = new ActionReference();
                tempRef.putIdentifier(charIDToTypeID("Lyr "), layerID);
                tempDesc.putReference(charIDToTypeID("null"), tempRef);
                executeAction(charIDToTypeID("slct"), tempDesc, DialogModes.NO);
                
                selectedLayers.push(app.activeDocument.activeLayer);
            }
        }
    } catch (e) {
        alert("获取图层失败: " + e.message);
    }
    return selectedLayers;
}