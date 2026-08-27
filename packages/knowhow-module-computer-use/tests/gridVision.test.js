const { analyzeGridFrame } = require('../ts_build/gridVision');

function frame(width, height, color=[30,30,30]) {
  const data=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++){data[i*4]=color[0];data[i*4+1]=color[1];data[i*4+2]=color[2];data[i*4+3]=255;}
  return {sequence:1,capturedAt:1,receivedAt:1,width,height,data,region:{x:0,y:0,width,height},scaleX:1,scaleY:1};
}
function rect(f,x,y,w,h,c){for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*f.width+xx)*4;f.data[i]=c[0];f.data[i+1]=c[1];f.data[i+2]=c[2];}}

test('analyzeGridFrame returns cells, semantic patterns, and color components',()=>{
  const f=frame(40,20,[30,30,30]);
  rect(f,20,0,20,20,[70,70,70]);
  rect(f,24,4,5,8,[30,120,240]);
  rect(f,30,4,5,8,[240,120,30]);
  const result=analyzeGridFrame(f,{
    columns:2,rows:1,inset:0,minComponentPixels:3,
    palette:[
      {name:'wall',color:'#1e1e1e',tolerance:5},
      {name:'floor',color:'#464646',tolerance:5},
      {name:'blue',color:'#1e78f0',tolerance:5},
      {name:'orange',color:'#f0781e',tolerance:5},
    ],
    patterns:[{name:'player',requirements:[{palette:'blue',minRatio:.05},{palette:'orange',minRatio:.05}]}],
  });
  expect(result.cells).toHaveLength(2);
  expect(result.cells[0].dominant).toBe('wall');
  expect(result.cells[1]).toMatchObject({dominant:'floor',pattern:'player'});
  expect(result.objects).toMatchObject([{type:'player',cell:{column:1,row:0}}]);
  expect(result.components.some(c=>c.palette==='blue'&&c.pixels===40)).toBe(true);
  expect(result.cells[1].paletteMeanColors).toMatchObject({blue:'#1e78f0',orange:'#f0781e'});
});

test('normalized masks distinguish patterns with the same palette composition',()=>{
  const f=frame(20,20,[0,0,0]);
  rect(f,0,0,10,20,[255,255,255]);
  const result=analyzeGridFrame(f,{
    columns:1,rows:1,inset:0,
    palette:[{name:'black',color:'#000000',tolerance:1},{name:'white',color:'#ffffff',tolerance:1}],
    patterns:[{name:'left_half',mask:['white black','white black'],maxMaskMismatch:0}],
  });
  expect(result.cells[0].pattern).toBe('left_half');
  expect(result.cells[0].confidence).toBe(1);
});



test('adaptive palette learns frequent neutral surface shades',()=>{
  const f=frame(40,20,[57,57,61]);
  rect(f,20,0,20,20,[103,102,107]);
  const result=analyzeGridFrame(f,{
    columns:2,rows:1,inset:0,
    palette:[
      {name:'wall',color:'#202020',tolerance:14},
      {name:'floor',color:'#505050',tolerance:14},
    ],
    adaptivePalette:{names:['wall','floor'],maxChroma:8,minClusterDistance:20},
  });
  expect(result.cells.map(cell=>cell.dominant)).toEqual(['wall','floor']);
  expect(result.resolvedPalette).toEqual([
    {name:'wall',color:'#3a3a3a',learned:true},
    {name:'floor',color:'#686868',learned:true},
  ]);
});



test('components expose edge-mounted bar orientation and facing',()=>{
  const f=frame(40,40,[30,30,30]);
  rect(f,5,32,30,4,[200,200,200]);
  const result=analyzeGridFrame(f,{
    columns:1,rows:1,inset:0,minComponentPixels:3,
    palette:[
      {name:'floor',color:'#1e1e1e',tolerance:2},
      {name:'bumper',color:'#c8c8c8',tolerance:2},
    ],
  });
  const bumper=result.components.find(component=>component.palette==='bumper');
  expect(bumper).toMatchObject({
    orientation:'horizontal',facing:'down',cell:{column:0,row:0},
  });
  expect(bumper.orientationConfidence).toBeGreaterThan(.8);
  expect(bumper.facingConfidence).toBeGreaterThan(.5);
});
