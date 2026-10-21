export type RegularResolutionReply={purchaseOrderId:number,purchaseOrderRef:string,eta:string,resolvedAt:string,resolvedBy:string};
export type RegularResolutionLine={id:number,itemName?:string,status:string,resolution?:RegularResolutionReply|null,purchase?:{demandId?:number},transferId?:number|null};
export type RegularResolutionRequest={id:number,revision:number,workflowVersion:number,status:string,regular?:{deliveryMethod?:string,resolution?:RegularResolutionReply,pickupTransfer?:unknown,handoffStatus?:string},lines?:RegularResolutionLine[],transfers?:{lines?:{id:number}[]}[]};
export type RegularResolutionDraft={requestId:number,lineId?:number,expectedRevision:number,purchaseOrderRef:string,eta:string};
export type StockingReplyDraft={requestId:number,lineId?:number,expectedRevision:number,message:string,eta?:string,salesOrderRef?:string};

// The page loads these browser globals as classic scripts. Declare the actual
// interfaces used by the changed modules so checkJs can validate their calls.
declare global {
  interface Window {
    MBBS_I18N?: {
      language:()=>string;
      displayDateTime?:(value:string)=>string;
      toggleHtml?:()=>string;
    };
    RegularStockUI: {
      [name:string]:unknown;
      customer:(request:{regular?:{customerName?:unknown}}|null|undefined)=>string;
      t:(en:string,zh:string)=>string;
      esc:(value:unknown)=>string;
      number:(value:unknown)=>string;
      apiError:(payload:unknown,status:number)=>Error;
      decision:(value:unknown)=>string;
      safety:(request:unknown,line:unknown)=>string;
      stocking:(request:unknown)=>boolean;
      stockingResult:(request:unknown)=>string;
      summary:(request:unknown)=>string;
    };
    RegularPurchaseUI: {
      purchase:(request:unknown)=>boolean;
      stock:(evidence?:{onHand?:unknown,available?:unknown,preferredStock?:unknown},unit?:string)=>string;
      detail:(request:unknown,scm?:boolean,options?:{
        selectedLineIds?:Set<number>;
        reviewedQuantities?:Record<number,string>;
        releaseReasons?:Record<number,string>;
        resolveDraft?:RegularResolutionDraft|null;
        busy?:boolean;
      })=>string;
      rounded:(value:unknown,line:{toPlt:unknown})=>number|null;
    };
    RegularStockResolution: {
      eligible:(request:RegularResolutionRequest|null|undefined,line?:RegularResolutionLine)=>boolean;
      button:(request:RegularResolutionRequest|null|undefined,busy?:boolean,line?:RegularResolutionLine)=>string;
      editor:(request:RegularResolutionRequest|null|undefined,draft?:RegularResolutionDraft|null,busy?:boolean,line?:RegularResolutionLine)=>string;
      result:(request:RegularResolutionRequest|null|undefined,line?:RegularResolutionLine)=>string;
    };
    RegularStockReply: {
      status:(request:unknown)=>string;
      label:(value:string)=>string|undefined;
      lineStatus:(request:unknown,line:RegularResolutionLine)=>string;
      eligible:(request:unknown,audience:string,operatorId?:string,line?:RegularResolutionLine)=>boolean;
      button:(request:unknown,audience:string,busy?:boolean,operatorId?:string,line?:RegularResolutionLine)=>string;
      panel:(request:unknown,audience:string,draft?:StockingReplyDraft|null,busy?:boolean,operatorId?:string,options?:{showButton?:boolean,line?:RegularResolutionLine})=>string;
    };
  }
}
