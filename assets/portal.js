
(function(){
  var entryType=document.documentElement.dataset.portalEntry||"main";
  var mode="in";
  var accountType=entryType==="parents"?"parent":"teacher";
  function localISODate(d){
    d=d||new Date();
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  var currentUser=null;
  var parentPortalData=null;
  var parentPortalRefreshInProgress=false;
  var parentSelectedLearnerIndex=0;
  var adminClasses=[];
  var gradeStudents=[];
  var sf10Students=[];
  var sf10ActiveRecordKey="manual";
  var sf10Initialized=false;
  var sf10GradeSyncRequestId=0;
  var rosterStudents=[];
  var nutritionalAssessmentCycle="BOSY";
  var nutritionalAssessmentDates={};
  var rosterParents=[];
  var spinWheelRosterEntries=[];
  var spinWheelRemovedIds=new Set();
  var inactiveStudentIds=new Set();
  var handledSections=[];
  var sectionGrades={};
  var handledSubjects=[];
  var availableSubjects=[];
  var eClassSubjectOptions=[];
  var sectionSubjects={};
  var teacherSubjectSection="";
  var activeStudentSection="__all__";
  var pendingStudentSection="__all__";
  var clearRosterSection="__all__";
  var clearRosterStudentCount=0;
  var studentSectionLocked=false;
  var defaultStudentSection="";
  var defaultStudentGrade="";
  var philIriScoreData=Object.create(null);
  var philIriScoreGuide=null;
  var philIriScoreLoadRequestId=0;
  var philIriScoreEditVersion=0;
  var philIriResultsRequestId=0;
  var philIriReadingSummaryRequestId=0;
  var gradeSummaryData=null;
  var attendanceData=null;
  var attendanceRequestId=0;
  var attendanceSummaryRequestId=0;
  var attendanceDirty=false;
  var activeAttendanceMonth="";
  var readingProgressData=null;
  var readingPeriod="BOSY";
  var readingAttempt=1;
  var readingRequestId=0;
  var readingDirty=false;
  var philIriData=null;
  var philIriComparisonData=null;
  var philIriSettings=null;
  var philIriSchoolData=null;
  var mpsLearners=[];
  var mpsReportContext="";
  var mpsRecordRequestId=0;
  var mpsSummaryRequestId=0;
  var philIriRequestId=0;
  var philIriAutosaveTimer=null;
  var philIriSaving=false;
  var rmaData=null;
  var rmaProfile=null;
  var rmaPeriod="BOSY";
  var rmaGradeLevel="Grade 5";
  var rmaEditingStudentId="";
  var rmaView="report";
  var rmaDirty=false;
  var rmaSaving=false;
  var rmaRequestId=0;
  var teacherProfileDirty=false;
  var teacherProfileDetailsDirty=false;
  var teacherProfileBasicDirty=false;
  var teacherProfileSchoolDirty=false;
  var teacherProfileSavedIdentity={name:"",email:"",classroomNumber:""};
  var teacherSubjectsDirty=false;
  var teacherSubjectsLocked=true;
  var teacherPasswordDirty=false;
  var activeGradeSelection={studentId:"",term:"Term 1"};
  var gradesDirty=false;
  var activeTermLocked=false;
  var activeEClassGradeSubjects=new Set();
  var gradeRecordLoading=false;
  var gradeRecordAvailable=false;
  var gradeSaving=false;
  var gradeEditUpdating=false;
  var gradeLoadRequestId=0;
  var eClassDirty=false;
  var appTheme="navy-gold";
  var performanceModeEnabled=false;
  var performanceModeStorageError="";
  var customThemes=[
    "ocean","sage","lavender","rose","sunset","amber","forest","mint","sky","indigo",
    "berry","coral","teal","sand","midnight","amethyst","emerald","slate","nord","cherry","electric","navy-gold"
  ];
  var appearanceStorageError="";
  var appearancePreferenceChanged=false;
  var $=function(i){return document.getElementById(i)};
  var studentFields=[
    ["lrn","LRN"],["lastName","Last name"],["firstName","First name"],["middleName","Middle name"],
    ["gender","Gender"],["birthdate","Birthdate"],["mothersMaidenName","Mother's Maiden name"],
    ["guardianRelationship","Guardian relationship"],["father","Father"],["currentResidence","Current residence"],
    ["religion","Religion"],["motherTongue","Mother tongue"],["dialects","Dialects"],["ethnicities","Ethnicities"]
  ];
  var allGradeFields=[
    ["filipino","Filipino"],["english","English"],["mathematics","Mathematics"],
    ["science","Science"],["aralingPanlipunan","Araling Panlipunan (AP)"],
    ["gmrc","GMRC/Values Education"],["eppTle","EPP / TLE"],
    ["musicAndArts","Music and Arts"],["physicalEducationAndHealth","Physical Education and Health"],
    ["makabansa","Makabansa"]
  ];
  var gradeFields=allGradeFields.slice(0,-1);

  function gradeInputId(key){
    return "grade"+key[0].toUpperCase()+key.slice(1);
  }

  function ensureGradeSubjectInput(subject){
    var inputId=gradeInputId(subject.key);
    if($(inputId))return $(inputId);
    var field=document.createElement("div");
    field.className="grade-field";
    field.dataset.gradeSubject=subject.key;
    var label=document.createElement("label");
    label.htmlFor=inputId;
    label.textContent=subject.label;
    var input=document.createElement("input");
    input.id=inputId;
    input.name=subject.key;
    input.type="number";
    input.min="0";
    input.max="100";
    input.step="0.01";
    input.inputMode="decimal";
    input.addEventListener("input",function(){
      gradesDirty=true;
      updateMapehAverage();
      updateGradeEditorState();
    });
    field.append(label,input);
    var grid=subject.key==="musicAndArts"||subject.key==="physicalEducationAndHealth"
      ?$("gradeMapehGrid")
      :$("gradeCoreGrid");
    grid.appendChild(field);
    return input;
  }

  function configureGradeSubjects(subjects){
    if(!Array.isArray(subjects)||!subjects.length)throw new Error("The subject list could not be loaded. Please refresh and try again.");
    var subjectKeys=new Set(subjects.map(function(subject){return subject.key}));
    if(subjectKeys.has("musicAndArts")&&subjectKeys.has("physicalEducationAndHealth"))subjectKeys.add("mapeh");
    $("gradeAverageRule").textContent=subjectKeys.has("mapeh")
      ?"MAPEH is the average of Music and Arts and Physical Education and Health. General Average uses the seven other subjects plus MAPEH."
      :"General Average uses the available subjects listed above.";
    gradeFields=subjects.map(function(subject){return[subject.key,subject.label]});
    subjects.forEach(ensureGradeSubjectInput);
    subjects.forEach(function(subject){
      var field=document.querySelector('[data-grade-subject="'+subject.key+'"]');
      if(field){
        var grid=subject.key==="musicAndArts"||subject.key==="physicalEducationAndHealth"
          ?$("gradeMapehGrid")
          :$("gradeCoreGrid");
        grid.appendChild(field);
      }
    });
    document.querySelectorAll("[data-grade-subject]").forEach(function(container){
      container.hidden=!subjectKeys.has(container.dataset.gradeSubject);
    });
    $("gradeCoreGroup").hidden=!subjects.some(function(subject){
      return subject.key!=="musicAndArts"&&subject.key!=="physicalEducationAndHealth"&&subject.key!=="mapeh";
    });
    $("gradeMapehGroup").hidden=!subjectKeys.has("musicAndArts")&&!subjectKeys.has("physicalEducationAndHealth")&&!subjectKeys.has("mapeh");
    subjects.forEach(function(subject){
      var inputId=gradeInputId(subject.key);
      var input=$(inputId);
      var label=document.querySelector('label[for="'+inputId+'"]');
      if(input&&label)label.textContent=subject.label;
    });
    updateMapehAverage();
  }

  function configureEClassSubjects(subjects,gradeSubjectDefinitions){
    if(!Array.isArray(subjects)||!subjects.length)throw new Error("The E-Class subject list could not be loaded. Please refresh and try again.");
    if(!Array.isArray(gradeSubjectDefinitions)||!gradeSubjectDefinitions.length)throw new Error("The grade subject mapping could not be loaded. Please refresh and try again.");
    var select=$("eClassSubject");
    eClassSubjectOptions=subjects.slice();
    var previous=select.value;
    select.replaceChildren();
    subjects.forEach(function(subject){select.add(new Option(subject,subject))});
    select.value=subjects.includes(previous)?previous:subjects[0];
    $("eClassMapehGroupField").hidden=!subjects.includes("MAPEH");
  }

  function applyTheme(theme){
    appTheme=theme;
    if(theme==="system")document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme=theme;
  }

  function applyPerformanceMode(enabled){
    performanceModeEnabled=enabled;
    document.documentElement.dataset.performanceMode=enabled?"on":"off";
    $("performanceModeToggle").setAttribute("aria-checked",String(enabled));
    $("performanceModeValue").textContent=enabled?"On":"Off";
  }

  try{
    performanceModeEnabled=window.localStorage.getItem("gradePortalPerformanceMode")==="on";
  }catch(error){
    performanceModeStorageError="Performance mode preference could not be loaded from this browser: "+error.message;
  }
  applyPerformanceMode(performanceModeEnabled);

  try{
    var savedTheme=window.localStorage.getItem("gradePortalTheme");
    if(savedTheme==="light"||savedTheme==="dark"||customThemes.includes(savedTheme))appTheme=savedTheme;
  }catch(error){
    appearanceStorageError="Theme preference could not be loaded from this browser.";
  }
  applyTheme(appTheme);

  api("/api/preferences/appearance").then(function(preferences){
    var savedTheme=preferences.theme;
    if(!appearancePreferenceChanged&&(savedTheme==="system"||savedTheme==="light"||savedTheme==="dark"||customThemes.includes(savedTheme))){
      applyTheme(savedTheme);
      $("appearanceSetting").value=savedTheme;
    }
  }).catch(function(error){
    appearanceStorageError="Appearance preference could not be loaded: "+error.message;
  });

  function render(){
    document.documentElement.dataset.role=accountType;
    var up=mode==="up";
    var isParent=accountType==="parent";
    var isParentsEntry=entryType==="parents";
    var portalName=isParentsEntry?"Parents Portal":"GraceDesk";
    document.title=portalName+" · "+(isParentsEntry?"GraceDesk":"Teach, Track, Thrive.");
    document.querySelector(".brand h1 span").textContent=portalName;
    document.querySelector(".brand h1 span").setAttribute("aria-label",portalName);
    document.querySelector(".brand-acronym").hidden=entryType!=="main";
    $("tagline").textContent=isParentsEntry
      ?"Sign in to view your child's learning."
      :isParent
      ?up?"Create an account to follow your child's learning.":"Sign in to view your child's learning."
      :up?"Create an account for your classroom.":"Sign in to your classroom.";
    $("authModeTitle").textContent=(isParent?"Parent / Guardian":"Teacher")+" "+(up?"create account":"sign in");
    $("authModeDescription").textContent=isParent
      ?up?"Register with the class code shared by your child's teacher.":"View attendance, reading progress, and grades shared by the teacher."
      :up?"Create your account and set up your classroom.":"Manage your classroom and learner records.";
    document.querySelectorAll("#auth [role='tablist'] .tab").forEach(function(b){
      b.setAttribute("aria-selected",String(b.dataset.mode===mode));
    });
    $("nameWrap").hidden=!up;
    $("teacherGradeWrap").hidden=!up||isParent;
    var gradeLevel=$("teacherGrade").value;
    var isSeniorHigh=gradeLevel==="Grade 11"||gradeLevel==="Grade 12";
    $("teacherStrandWrap").hidden=!up||isParent||!isSeniorHigh;
    if(!isSeniorHigh)$("teacherStrand").value="";
    $("parentClassCodeWrap").hidden=!up||!isParent;
    $("authHint").textContent=isParent
      ?up?"Your child's learner record will appear after their teacher links it to your account."
        :"New to the portal? Choose Create account and enter the class code from the teacher."
      :up?"Your classroom is created as part of teacher registration."
        :"New to the portal? Choose Create account to get started.";
    $("submit").textContent=up?(isParent?"Create parent account":"Create my account"):"Sign in";
    $("pw").autocomplete=up?"new-password":"current-password";
    clearErrs();
  }
  function clearErrs(){document.querySelectorAll(".err").forEach(function(e){e.textContent=""});$("msg").textContent=""}
  function setErr(f,t){var node=document.querySelector('[data-for="'+f+'"]'); if(node){node.textContent=t}}
  $("teacherGrade").onchange=function(){
    var isSeniorHigh=this.value==="Grade 11"||this.value==="Grade 12";
    $("teacherStrandWrap").hidden=mode!=="up"||!isSeniorHigh;
    if(!isSeniorHigh)$("teacherStrand").value="";
  };

  async function api(url,options){
    var response;
    try{
      var requestOptions=Object.assign({credentials:"same-origin"},options||{});
      if(!requestOptions.signal){
        var controller=new AbortController();
        requestOptions.signal=controller.signal;
        window.setTimeout(function(){controller.abort();},20000);
      }
      response=await fetch(url,requestOptions);
    }catch(error){
      if(error instanceof TypeError){
        throw new Error("Can't reach the portal server. Restart it with npm start, open the exact address printed in its terminal, refresh this page, and try again. Do not use VS Code Live Preview.");
      }
      throw error;
    }
    var contentType=response.headers.get("content-type")||"";
    if(!contentType.toLowerCase().includes("application/json")){
      throw new Error("The portal API did not return JSON. Open the portal from the address printed by npm start, not Live Preview.");
    }
    var result=await response.json();
    if(!response.ok){
      var requestError=new Error(result.error||"The request could not be completed.");
      requestError.status=response.status;
      throw requestError;
    }
    return result;
  }

  async function storeBrowserCredential(email,password){
    if(!window.PasswordCredential||!navigator.credentials
      ||typeof navigator.credentials.store!=="function")return false;
    try{
      await navigator.credentials.store(new window.PasswordCredential({id:email,password:password}));
      return true;
    }catch(error){
      console.error("Could not save the sign-in with the browser password manager:",error);
      $("msg").textContent="The browser could not save your sign-in. Enter it manually next time.";
      return false;
    }
  }

  async function rememberAuthenticatedAccount(email,password){
    try{
      window.localStorage.setItem("gradePortalRecentSignInEmail",email);
    }catch(error){
      console.error("Could not save the recent sign-in email:",error);
    }
    var bridge=window.gradePortal;
    if(bridge&&typeof bridge.saveRememberedLogin==="function"){
      try{
        var result=await bridge.saveRememberedLogin({email:email,password:password});
        if(result.saved)return;
        if(result.reason!=="unavailable"){
          $("msg").textContent="Signed in, but this device could not save your account for next time.";
        }
      }catch(error){
        console.error("Could not securely remember the signed-in account:",error);
        $("msg").textContent="Signed in, but this device could not securely remember your account.";
        return;
      }
    }
    await storeBrowserCredential(email,password);
  }

  async function prefillRememberedAccount(){
    var recentEmail="";
    try{
      recentEmail=window.localStorage.getItem("gradePortalRecentSignInEmail")||"";
      if(recentEmail&&!$("email").value)$("email").value=recentEmail;
    }catch(error){
      console.error("Could not load the recent sign-in email:",error);
    }
    var bridge=window.gradePortal;
    if(bridge&&typeof bridge.loadRememberedLogin==="function"){
      var saved=await bridge.loadRememberedLogin();
      if(saved&&saved.credentials){
        $("email").value=saved.credentials.email;
        $("pw").value=saved.credentials.password;
        return;
      }
    }
    if(!window.PasswordCredential||!navigator.credentials
      ||typeof navigator.credentials.get!=="function")return;
    try{
      var credential=await navigator.credentials.get({password:true,mediation:"silent"});
      if(credential&&credential.type==="password"
        &&(!recentEmail||credential.id.toLowerCase()===recentEmail.toLowerCase())){
        if(!recentEmail)$("email").value=credential.id;
        $("pw").value=credential.password;
      }
    }catch(error){
      console.error("Could not load the saved sign-in from the browser password manager:",error);
    }
  }

  async function updateRememberedPassword(password){
    var bridge=window.gradePortal;
    if(bridge&&typeof bridge.updateRememberedPassword==="function"){
      try{
        var result=await bridge.updateRememberedPassword(password);
        if(result.saved)return;
        if(result.reason!=="missing"&&result.reason!=="unavailable"){
          $("msg").textContent="Your password changed, but the saved sign-in could not be updated. Sign in manually next time.";
        }
      }catch(error){
        console.error("Could not update the securely remembered password:",error);
        $("msg").textContent="Your password changed, but the saved sign-in could not be updated. Sign in manually next time.";
      }
    }
    var email=$("email").value;
    if(email)await storeBrowserCredential(email,password);
  }

  function applyStorageHealth(){
    $("storageStatus").textContent="Connected. Portal records are saved on this device.";
  }

  document.querySelectorAll(".tab[role='tab']").forEach(function(b){b.onclick=function(){mode=b.dataset.mode;render()}});
  $("showPw").onclick=function(){var p=$("pw"),s=p.type==="password";p.type=s?"text":"password";this.textContent=s?"Hide":"Show"};

  $("form").onsubmit=async function(e){
    e.preventDefault();clearErrs();
    var up=mode==="up",ok=true;
    var role=accountType;
    var isParent=role==="parent";
    var name=$("name").value.trim(),email=$("email").value.trim().toLowerCase(),pw=$("pw").value;
    var classCode=$("parentClassCode").value.trim();
    var grade=$("teacherGrade").value.trim();
    var strand=$("teacherStrand").value;
    if(up&&!name){setErr("name","Enter your name.");ok=false}
    if(!/^\S+@\S+\.\S+$/.test(email)){setErr("email","Enter an email like name@example.com.");ok=false}
    if(!pw){setErr("pw","Enter a password.");ok=false}
    else if(up&&pw.length<6){setErr("pw","Use at least 6 characters.");ok=false}
    if(up&&isParent&&!classCode){setErr("classCode","Enter the class code shared by your child's teacher.");ok=false}
    if(up&&!isParent&&!grade){setErr("grade","Enter your grade level.");ok=false}
    if(up&&!isParent&&(grade==="Grade 11"||grade==="Grade 12")&&!strand){setErr("strand","Choose the student's strand.");ok=false}
    if(!ok)return;
    var submit=$("submit");
    submit.disabled=true;
    submit.textContent=up?(isParent?"Creating parent account...":"Saving account..."):"Signing in...";
    try{
      var result=await api(up?"/api/auth/register":"/api/auth/login",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          name:name,
          email:email,
          password:pw,
          role:role,
          extra:isParent?classCode:undefined,
          grade:grade,
          strand:strand
        })
      });
      await enter(result.user);
      await rememberAuthenticatedAccount(email,pw);
      $("pw").value="";
    }catch(error){
      $("msg").textContent=error instanceof TypeError
        ?"Can't reach the portal server. Run npm start in the portal folder, then open the address printed in the terminal."
        :error.message;
    }finally{
      submit.disabled=false;
      submit.textContent=up?(accountType==="parent"?"Create parent account":"Create my account"):"Sign in";
    }
  };

  function renderStudents(students){
    var tbody=$("studentRows");
    tbody.textContent="";
    setStudentListVisible(true);
    var visibleStudents=filterStudentsForActiveSection(students);
    var activeStudents=visibleStudents.filter(function(s){return !s.enrollmentStatus});
    syncSpinWheelEntriesFromRoster(activeStudents);
    var inactiveCount=visibleStudents.length-activeStudents.length;
    inactiveStudentIds=new Set(students.filter(function(s){return s.enrollmentStatus}).map(function(s){return s.id}));
    $("studentCount").textContent=activeStudents.length+" active student"+(activeStudents.length===1?"":"s")
      +(inactiveCount?" · "+inactiveCount+" NLS/TO excluded":"");
    updateClearStudentRosterButton(students);
    $("studentEmpty").hidden=visibleStudents.length!==0;
    $("studentTable").hidden=visibleStudents.length===0;
    $("studentEmpty").querySelector("h3").textContent=students.length
      ?"No students in this section yet"
      :"No students added yet";
    $("studentEmpty").querySelector("p").textContent=students.length
      ?"Add students to this section or select another section above."
      :"Add your first student to start building the class roster.";
    visibleStudents.forEach(function(student){
      var row=document.createElement("tr");
      var nameCell=document.createElement("td");
      var identity=document.createElement("div");
      identity.className="student-identity";
      var avatar=document.createElement("span");
      avatar.className="student-avatar";
      avatar.setAttribute("aria-hidden","true");
      avatar.textContent=((student.firstName||"").charAt(0)+(student.lastName||"").charAt(0)).toUpperCase()||"?";
      var identityText=document.createElement("div");
      var name=document.createElement("span");
      name.className="student-name";
      name.textContent=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
      identityText.appendChild(name);
      var shortLrn=document.createElement("span");
      shortLrn.className="student-sub";
      shortLrn.textContent="LRN "+student.lrn;
      identityText.appendChild(shortLrn);
      if(student.enrollmentStatus){
        row.className="student-row-inactive";
        var statusTag=document.createElement("span");
        statusTag.className="student-status-tag "+(student.enrollmentStatus==="NLS"?"nls":"to");
        statusTag.textContent=student.enrollmentStatus==="NLS"?"NLS · No longer in school":"TO · Transferred out";
        identityText.appendChild(statusTag);
      }
      identity.append(avatar,identityText);
      nameCell.appendChild(identity);
      row.appendChild(nameCell);
      var lrnCell=document.createElement("td");
      lrnCell.className="student-lrn";
      lrnCell.textContent=student.lrn;
      row.appendChild(lrnCell);
      var genderCell=document.createElement("td");
      var genderText=String(student.gender||"");
      var badge=document.createElement("span");
      badge.className="gender-badge"+(/^m/i.test(genderText)?" male":/^f/i.test(genderText)?" female":"");
      badge.textContent=genderText||"—";
      genderCell.appendChild(badge);
      row.appendChild(genderCell);
      appendTextCell(row,student.birthdate);
      var detailCell=document.createElement("td");
      var viewButton=document.createElement("button");
      viewButton.type="button";
      viewButton.className="student-details-link";
      viewButton.textContent="View details";
      viewButton.addEventListener("click",function(){showStudentDetail(student)});
      detailCell.appendChild(viewButton);
      if(student.enrollmentStatus){
        var rowDelete=document.createElement("button");
        rowDelete.type="button";
        rowDelete.className="student-details-link danger";
        rowDelete.textContent="Delete";
        rowDelete.addEventListener("click",function(){openDeleteStudentDialog(student)});
        detailCell.appendChild(rowDelete);
      }
      row.appendChild(detailCell);
      tbody.appendChild(row);
    });
    var males=activeStudents.filter(function(s){return /^m/i.test(String(s.gender||""))}).length;
    var females=activeStudents.filter(function(s){return /^f/i.test(String(s.gender||""))}).length;
    $("rosterChips").textContent="";
    [["Male",males],["Female",females],["Total",activeStudents.length],["NLS/TO",inactiveCount]].forEach(function(pair){
      var chip=document.createElement("span");
      chip.className="roster-chip";
      chip.textContent=pair[0]+": "+pair[1];
      $("rosterChips").appendChild(chip);
    });
    filterStudentRows();
  }

  function setStudentListVisible(visible){
    var card=$("studentRosterCard");
    card.querySelector(".data-card-header").hidden=!visible;
    card.querySelector(".roster-toolbar").hidden=!visible;
    card.querySelector(".table-wrap").hidden=!visible;
    $("studentDetailView").hidden=visible;
  }

  function showStudentDetail(student){
    var view=$("studentDetailView");
    view.replaceChildren();
    var fullName=[student.firstName,student.middleName,student.lastName].filter(Boolean).join(" ");
    var head=document.createElement("div");
    head.className="student-detail-head";
    var avatar=document.createElement("span");
    avatar.className="student-avatar large";
    avatar.textContent=((student.firstName||"").charAt(0)+(student.lastName||"").charAt(0)).toUpperCase()||"?";
    var titles=document.createElement("div");
    titles.className="student-detail-title";
    var title=document.createElement("h2");
    title.textContent=fullName||"Student";
    var sub=document.createElement("p");
    sub.textContent="LRN "+(student.lrn||"—")+" · "+(student.section||"Unassigned");
    titles.append(title,sub);
    var back=document.createElement("button");
    back.type="button";
    back.className="student-details-link";
    back.textContent="Hide details";
    back.addEventListener("click",function(){setStudentListVisible(true)});
    head.append(avatar,titles,back);
    if(student.enrollmentStatus){
      var detailTag=document.createElement("span");
      detailTag.className="student-status-tag "+(student.enrollmentStatus==="NLS"?"nls":"to");
      detailTag.textContent=student.enrollmentStatus==="NLS"?"NLS · No longer in school":"TO · Transferred out";
      titles.appendChild(detailTag);
      var detailDelete=document.createElement("button");
      detailDelete.type="button";
      detailDelete.className="student-details-link danger";
      detailDelete.textContent="Delete student";
      detailDelete.addEventListener("click",function(){openDeleteStudentDialog(student)});
      head.appendChild(detailDelete);
      back.style.marginLeft="auto";
      detailDelete.style.marginLeft="0";
    }
    view.appendChild(head);
    var groups=[
      ["Personal information",["lastName","firstName","middleName","gender","birthdate","lrn"]],
      ["Family",["mothersMaidenName","father","guardianRelationship"]],
      ["Background",["currentResidence","religion","motherTongue","dialects","ethnicities"]]
    ];
    var labels={};
    studentFields.forEach(function(field){labels[field[0]]=field[1]});
    groups.forEach(function(group){
      var section=document.createElement("section");
      section.className="student-detail-group";
      var heading=document.createElement("h3");
      heading.textContent=group[0];
      var grid=document.createElement("dl");
      grid.className="details-grid";
      group[1].forEach(function(key){
        var item=document.createElement("div");
        item.className="detail-item";
        var label=document.createElement("dt");
        label.textContent=labels[key]||key;
        var value=document.createElement("dd");
        value.textContent=student[key]||"—";
        item.append(label,value);
        grid.appendChild(item);
      });
      if(group[0]==="Personal information"){
        var sectionItem=document.createElement("div");
        sectionItem.className="detail-item";
        var sectionLabel=document.createElement("dt");
        sectionLabel.textContent="Section";
        var sectionValue=document.createElement("dd");
        sectionValue.textContent=student.section||"Unassigned";
        sectionItem.append(sectionLabel,sectionValue);
        grid.appendChild(sectionItem);
      }
      section.append(heading,grid);
      view.appendChild(section);
    });
    var parentSection=document.createElement("section");
    parentSection.className="student-detail-group";
    var parentHeading=document.createElement("h3");
    parentHeading.textContent="Parent access";
    var parentDescription=document.createElement("p");
    parentDescription.className="student-parent-link-help";
    parentDescription.textContent="Link a parent account to share this pupil's attendance, reading progress, and term grades in the Parent Portal.";
    var parentControls=document.createElement("div");
    parentControls.className="student-parent-link-controls";
    var parentField=document.createElement("div");
    parentField.className="form-field";
    var parentLabel=document.createElement("label");
    parentLabel.htmlFor="studentParentAccount";
    parentLabel.textContent="Parent / Guardian account";
    var parentSelect=document.createElement("select");
    parentSelect.id="studentParentAccount";
    parentSelect.setAttribute("aria-label","Choose a parent account for "+fullName);
    parentSelect.add(new Option("No parent linked", ""));
    rosterParents.forEach(function(parent){
      var label=parent.name+(parent.email?" · "+parent.email:"");
      parentSelect.add(new Option(label,parent.id));
    });
    parentSelect.value=rosterParents.some(function(parent){return parent.id===student.parentUserId})
      ?student.parentUserId
      :"";
    parentField.append(parentLabel,parentSelect);
    var saveParentButton=document.createElement("button");
    saveParentButton.type="button";
    saveParentButton.className="btn ghost";
    saveParentButton.textContent="Save parent link";
    saveParentButton.addEventListener("click",async function(){
      saveParentButton.disabled=true;
      saveParentButton.textContent="Saving...";
      $("studentNotice").textContent="";
      $("studentNotice").classList.remove("error");
      try{
        var result=await api("/api/students/"+encodeURIComponent(student.id)+"/parent",{
          method:"PUT",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({parentUserId:parentSelect.value})
        });
        if(!result.saved)throw new Error("The parent link was not saved. Refresh the roster and try again.");
        student.parentUserId=result.parentUserId||"";
        var rosterStudent=rosterStudents.find(function(item){return item.id===student.id});
        if(rosterStudent)rosterStudent.parentUserId=student.parentUserId;
        $("studentNotice").textContent=student.parentUserId
          ?"Parent account linked. Their portal will show this pupil's shared records."
          :"Parent account unlinked.";
      }catch(error){
        $("studentNotice").textContent=error.message;
        $("studentNotice").classList.add("error");
      }finally{
        saveParentButton.disabled=false;
        saveParentButton.textContent="Save parent link";
      }
    });
    parentControls.append(parentField,saveParentButton);
    var parentHelp=document.createElement("p");
    parentHelp.className="student-parent-link-help";
    parentHelp.textContent=rosterParents.length
      ?"Choose an account registered with this class. Parents can sign up using the class code."
      :"No parent accounts are registered for this class yet. Share your class code so parents can sign up.";
    parentSection.append(parentHeading,parentDescription,parentControls,parentHelp);
    view.appendChild(parentSection);
    setStudentListVisible(false);
    view.scrollIntoView({block:"start"});
  }

  function filterStudentRows(){
    var term=$("studentSearch").value.trim().toLowerCase();
    Array.prototype.forEach.call($("studentRows").rows,function(row){
      var text=row.cells[0].textContent.toLowerCase()+" "+row.cells[1].textContent.toLowerCase();
      row.hidden=Boolean(term)&&text.indexOf(term)===-1;
    });
  }

  function updateSpinWheelEntriesDisplay(forceUpdate){
    var availableEntries=spinWheelRosterEntries.filter(function(entry){return !spinWheelRemovedIds.has(entry.id);});
    var wheelEntries=$("spinWheelEntries");
    var updatedValue=availableEntries.map(function(entry){return entry.name;}).join("\n");
    var removedCount=spinWheelRosterEntries.length-availableEntries.length;
    $("spinWheelHint").textContent=availableEntries.length
      ?removedCount
        ?availableEntries.length+" of "+spinWheelRosterEntries.length+" active pupils remain on the wheel."
        :availableEntries.length+" active pupil"+(availableEntries.length===1?"":"s")+" loaded from the selected roster section. At least two are required to spin."
      :spinWheelRosterEntries.length
        ?"All active pupils have been selected. Return pupils or reset the list to spin again."
        :"No active pupils in the selected roster section. Add pupils to the roster first.";
    if(wheelEntries.value===updatedValue&&!forceUpdate)return;
    wheelEntries.value=updatedValue;
    wheelEntries.dispatchEvent(new Event("input",{bubbles:true}));
  }

  function syncSpinWheelEntriesFromRoster(students){
    var previousState=JSON.stringify([
      spinWheelRosterEntries.map(function(entry){return [entry.id,entry.name];}),
      Array.from(spinWheelRemovedIds).sort()
    ]);
    var nameOccurrences=Object.create(null);
    spinWheelRosterEntries=(Array.isArray(students)?students:[])
      .filter(function(student){return student&&!student.enrollmentStatus;})
      .map(function(student){
        var name=String(student.firstName||"").replace(/\s+/g," ").trim();
        if(!name)return null;
        var id=student.id==null?"":String(student.id).trim();
        if(!id){
          var nameKey=name.toLowerCase();
          nameOccurrences[nameKey]=(nameOccurrences[nameKey]||0)+1;
          id="name:"+nameKey+":"+nameOccurrences[nameKey];
        }else{
          id="student:"+id;
        }
        return {id:id,name:name};
      })
      .filter(Boolean);
    var activeIds=new Set(spinWheelRosterEntries.map(function(entry){return entry.id;}));
    spinWheelRemovedIds.forEach(function(id){
      if(!activeIds.has(id))spinWheelRemovedIds.delete(id);
    });
    var currentState=JSON.stringify([
      spinWheelRosterEntries.map(function(entry){return [entry.id,entry.name];}),
      Array.from(spinWheelRemovedIds).sort()
    ]);
    updateSpinWheelEntriesDisplay(previousState!==currentState);
  }

  function removeSpinWheelPupil(id){
    if(!spinWheelRosterEntries.some(function(entry){return entry.id===id;})||spinWheelRemovedIds.has(id))return false;
    spinWheelRemovedIds.add(id);
    updateSpinWheelEntriesDisplay();
    return true;
  }

  function returnSpinWheelPupil(id){
    if(!spinWheelRemovedIds.has(id))return false;
    spinWheelRemovedIds.delete(id);
    updateSpinWheelEntriesDisplay();
    return true;
  }

  function resetSpinWheelPupils(){
    if(!spinWheelRemovedIds.size)return false;
    spinWheelRemovedIds.clear();
    updateSpinWheelEntriesDisplay();
    return true;
  }
  $("studentSearch").addEventListener("input",filterStudentRows);

  function splitHandledList(value){
    var seen=new Set();
    return value.split(/[,\n]/).map(function(entry){return entry.trim()}).filter(function(entry){
      if(!entry)return false;
      var key=entry.toLowerCase();
      if(seen.has(key))return false;
      seen.add(key);
      return true;
    });
  }

  function renderTeacherSubjectChoices(subjects,selectedSubjects){
    var legacySubjectNames={
      "english":"English Language Reading and Literacy",
      "gmrc/values education":"Good Manners and Right Conduct (GMRC)",
      "epp / tle":"Edukasyong Pantahanan at Pangkabuhayan (EPP)",
      "physical education and health":"Physical Education and Health (PEH)"
    };
    var availableSubjectNames=new Set(subjects.map(function(subject){return subject.toLowerCase()}));
    var normalizedSelectedSubjects=selectedSubjects.map(function(subject){
      var subjectKey=subject.toLowerCase();
      return availableSubjectNames.has(subjectKey)?subject:legacySubjectNames[subjectKey]||subject;
    });
    var choices=Array.from(new Set(subjects.concat(normalizedSelectedSubjects.filter(function(subject){
      return !subjects.some(function(option){return option.toLowerCase()===subject.toLowerCase()});
    }))));
    var selected=new Set(normalizedSelectedSubjects.map(function(subject){return subject.toLowerCase()}));
    var container=$("teacherProfileSubjectsHandled");
    container.replaceChildren();
    choices.forEach(function(subject,index){
      var label=document.createElement("label");
      label.className="teacher-subject-option";
      var checkbox=document.createElement("input");
      checkbox.type="checkbox";
      checkbox.value=subject;
      checkbox.id="teacherProfileSubject"+index;
      checkbox.checked=selected.has(subject.toLowerCase());
      var text=document.createElement("span");
      text.textContent=subject;
      label.htmlFor=checkbox.id;
      label.appendChild(checkbox);
      label.appendChild(text);
      container.appendChild(label);
    });
  }

  function getTeacherSubjectsForSection(section){
    var key=Object.keys(sectionSubjects).find(function(storedSection){
      return storedSection.toLowerCase()===section.toLowerCase();
    });
    return key?sectionSubjects[key]:[];
  }

  function syncLessonPlanLearningAreaOptions(selectId,placeholder){
    var select=$(selectId);
    if(!select)return;
    var currentValue=select.value.trim().toLowerCase();
    var subjects=getTeacherSubjectsForSection(teacherSubjectSection);
    select.replaceChildren(new Option(subjects.length?placeholder:"No subjects selected in Teacher Profile",""));
    subjects.forEach(function(subject){select.add(new Option(subject,subject))});
    var selectedSubject=subjects.find(function(subject){return subject.toLowerCase()===currentValue});
    select.value=selectedSubject||"";
    select.disabled=subjects.length===0;
  }

  function syncLessonPlanLearningAreas(){
    syncLessonPlanLearningAreaOptions("filipinoLearningArea","Pumili ng asignatura");
    syncLessonPlanLearningAreaOptions("englishLearningArea","Select a learning area");
  }

  function populateTeacherSubjectSections(preferredSection){
    var select=$("teacherSubjectSection");
    select.replaceChildren();
    handledSections.forEach(function(section){
      select.add(new Option(getSectionOptionLabel(section),section));
    });
    var selectionExists=handledSections.some(function(section){
      return section.toLowerCase()===String(preferredSection||"").toLowerCase();
    });
    teacherSubjectSection=selectionExists?handledSections.find(function(section){
      return section.toLowerCase()===String(preferredSection).toLowerCase();
    }):handledSections[0]||"";
    select.value=teacherSubjectSection;
    select.disabled=handledSections.length===0;
    syncLessonPlanLearningAreas();
    syncEnglishLessonPlanProfileFields();
    renderTeacherSubjectChoices(availableSubjects,getTeacherSubjectsForSection(teacherSubjectSection));
    updateTeacherSubjectLockState();
  }

  function getCheckedTeacherSubjects(){
    return Array.from($("teacherProfileSubjectsHandled").querySelectorAll('input[type="checkbox"]:checked'))
      .map(function(checkbox){return checkbox.value});
  }

  function updateTeacherSubjectLockState(){
    $("teacherSubjectSection").disabled=!teacherSubjectsLocked||handledSections.length===0;
    $("teacherProfileSubjectsHandled").querySelectorAll('input[type="checkbox"]').forEach(function(checkbox){
      checkbox.disabled=teacherSubjectsLocked;
    });
    $("toggleTeacherSubjects").textContent=teacherSubjectsLocked?"Add Subjects":"Save & Lock Subjects";
    $("toggleTeacherSubjects").setAttribute("aria-pressed",String(teacherSubjectsLocked));
    $("teacherSubjectsHint").textContent=teacherSubjectsLocked
      ?"Showing subjects for "+(teacherSubjectSection||"the selected section")+". Choose Add Subjects to edit."
      :"Select subjects taught in "+(teacherSubjectSection||"the selected section")+", then save to lock.";
  }

  function getSectionGrade(section){
    var key=Object.keys(sectionGrades).find(function(entry){return entry.toLowerCase()===section.toLowerCase()});
    if(key)return sectionGrades[key];
    return section.toLowerCase()===defaultStudentSection.toLowerCase()?defaultStudentGrade:"";
  }

  function getSectionOptionLabel(section){
    var grade=getSectionGrade(section);
    return grade?section+" - "+grade:section;
  }

  function syncEnglishLessonPlanProfileFields(){
    var teacherName=$("teacherProfileName");
    var teacherPosition=$("teacherProfilePosition");
    var grade=$("teacherProfileGrade");
    var section=$("teacherSubjectSection");
    var schoolHead=$("teacherProfileSchoolHead");
    var schoolHeadPosition=$("teacherProfileSchoolHeadPosition");
    var filipinoTeacherName=$("filipinoTeacherName");
    var filipinoGradeSection=$("filipinoGradeSection");
    var filipinoPreparedBy=$("filipinoPreparedBy");
    var filipinoPreparedPosition=$("filipinoPreparedPosition");
    var filipinoReviewedBy=$("filipinoReviewedBy");
    var filipinoNotedBy=$("filipinoNotedBy");
    var lessonPlanTeacherName=$("englishTeacherName");
    var lessonPlanGradeSection=$("englishGradeSection");
    var lessonPlanPreparedBy=$("englishPreparedBy");
    var lessonPlanPreparedPosition=$("englishPreparedPosition");
    var lessonPlanReviewedBy=$("englishReviewedBy");
    var lessonPlanNotedBy=$("englishNotedBy");
    if(!teacherName||!teacherPosition||!grade||!section||!schoolHead||!schoolHeadPosition
      ||!filipinoTeacherName||!filipinoGradeSection||!filipinoPreparedBy
      ||!filipinoPreparedPosition||!filipinoReviewedBy||!filipinoNotedBy
      ||!lessonPlanTeacherName||!lessonPlanGradeSection||!lessonPlanPreparedBy
      ||!lessonPlanPreparedPosition||!lessonPlanReviewedBy||!lessonPlanNotedBy)return;
    lessonPlanTeacherName.value=teacherName.value.trim();
    var gradeValue=grade.value.trim().replace(/^grade\s*/i,"").trim();
    var sectionValue=section.value.trim();
    lessonPlanGradeSection.value=gradeValue
      ?"GRADE "+gradeValue.toUpperCase()+(sectionValue?"-"+sectionValue.toUpperCase():"")
      :"";
    filipinoTeacherName.value=teacherName.value.trim();
    filipinoGradeSection.value=lessonPlanGradeSection.value;
    filipinoPreparedBy.value=teacherName.value.trim();
    filipinoPreparedPosition.value=teacherPosition.value.trim();
    filipinoReviewedBy.value=schoolHead.value.trim();
    filipinoNotedBy.value=schoolHeadPosition.value.trim();
    lessonPlanPreparedBy.value=teacherName.value.trim();
    lessonPlanPreparedPosition.value=teacherPosition.value.trim();
    lessonPlanReviewedBy.value=schoolHead.value.trim();
    lessonPlanNotedBy.value=schoolHeadPosition.value.trim();
    window.dispatchEvent(new Event("lessonPlanProfileFieldsSynced"));
  }

  function populateSectionControls(preferredSection){
    var filter=$("studentSectionFilter");
    var previous=preferredSection||activeStudentSection||filter.value;
    filter.replaceChildren();
    if(rosterStudents.length){
      handledSections.forEach(function(section){filter.add(new Option(getSectionOptionLabel(section),section))});
    }
    var hasUnassignedStudents=rosterStudents.some(function(student){return !student.section});
    if(rosterStudents.length&&hasUnassignedStudents){
      filter.add(new Option("Unassigned","__unassigned__"));
    }
    if(!filter.options.length){
      filter.add(new Option("No sections available",""));
      filter.options[0].disabled=true;
    }
    var canKeep=Array.from(filter.options).some(function(option){return option.value===previous});
    pendingStudentSection=canKeep?previous:(handledSections[0]||(hasUnassignedStudents?"__unassigned__":""));
    if(!canKeep){
      activeStudentSection=pendingStudentSection;
      studentSectionLocked=false;
    }
    filter.value=studentSectionLocked?activeStudentSection:pendingStudentSection;
    updateSectionSelectionControls();

    var studentSection=$("studentSection");
    studentSection.replaceChildren();
    studentSection.add(new Option(handledSections.length?"Choose section":"No sections configured",""));
    handledSections.forEach(function(section){studentSection.add(new Option(getSectionOptionLabel(section),section))});
    var preferredStudentSection=activeStudentSection==="__unassigned__"
      ?handledSections[0]||""
      :activeStudentSection;
    if(handledSections.some(function(section){return section.toLowerCase()===preferredStudentSection.toLowerCase()})){
      studentSection.value=preferredStudentSection;
    }
    studentSection.disabled=handledSections.length===0;
  }

  function filterStudentsForActiveSection(students,sectionFilter){
    sectionFilter=typeof sectionFilter==="string"?sectionFilter:activeStudentSection;
    if(!Array.isArray(students)||!sectionFilter)return [];
    return students.filter(function(student){
      var rosterStudent=rosterStudents.find(function(candidate){
        return (student.id&&candidate.id===student.id)
          ||(student.studentId&&candidate.id===student.studentId)
          ||(student.lrn&&candidate.lrn===student.lrn);
      });
      var section=String(student.section||rosterStudent&&rosterStudent.section||"");
      if(sectionFilter==="__unassigned__")return !section;
      return section.toLowerCase()===sectionFilter.toLowerCase();
    });
  }

  function studentSectionFilterLabel(section){
    if(section==="__unassigned__")return "Unassigned";
    var option=Array.from($("studentSectionFilter").options).find(function(candidate){
      return candidate.value===section;
    });
    return option?option.textContent:section;
  }

  function updateClearStudentRosterButton(students){
    var section=$("studentSectionFilter").value;
    var count=filterStudentsForActiveSection(students,section).length;
    var button=$("clearStudentRoster");
    button.disabled=!section||count===0;
    button.title="Clear the "+studentSectionFilterLabel(section)+" roster.";
  }

  function updateSectionSelectionControls(){
    var filter=$("studentSectionFilter");
    var button=$("selectStudentSection");
    filter.disabled=studentSectionLocked;
    button.textContent=studentSectionLocked?"Change Section":"Apply Section";
    button.setAttribute("aria-pressed",String(studentSectionLocked));
    button.title=studentSectionLocked
      ?"Section selection is applied. Choose Change Section to select another."
      :"Apply and lock the selected section across the portal.";
  }

  function appendTextCell(row,text){
    var cell=document.createElement("td");
    cell.textContent=text||"—";
    row.appendChild(cell);
    return cell;
  }

  function reconcileEClassScoresWithRoster(students){
    var classId=currentUser&&(currentUser.activeClassId||currentUser.id);
    if(!classId)return 0;
    var prefix="gradePortalEClassScores:"+String(classId)+":";
    var studentIds=new Set(students.map(function(student){return String(student.id)}));
    var staleKeys=[];
    for(var index=0;index<window.localStorage.length;index++){
      var key=window.localStorage.key(index);
      if(!key||!key.startsWith(prefix))continue;
      var separator=key.lastIndexOf(":");
      if(separator<prefix.length)continue;
      var studentId;
      try{
        studentId=decodeURIComponent(key.slice(separator+1));
      }catch(error){
        throw new Error("A saved E-Class score has an invalid student key: "+error.message);
      }
      if(!studentIds.has(studentId))staleKeys.push(key);
    }
    staleKeys.forEach(function(key){window.localStorage.removeItem(key)});
    return staleKeys.length;
  }

  async function loadStudents(){
    $("studentNotice").textContent="";
    $("studentNotice").classList.remove("error");
    $("studentCount").textContent="Loading students...";
    $("studentTable").hidden=true;
    $("studentEmpty").hidden=true;
    $("studentRows").replaceChildren();
    try{
      var result=await api("/api/students");
      rosterStudents=result.students;
      if(!Array.isArray(rosterStudents)){
        throw new Error("The roster response is outdated. Restart the portal server to load the updated backend.");
      }
      if(!Array.isArray(result.parents)){
        throw new Error("The roster response is outdated. Restart the portal server to load parent account links.");
      }
      rosterParents=result.parents;
      if(Array.isArray(result.sectionsHandled)){
        handledSections=result.sectionsHandled;
        populateSectionControls(activeStudentSection);
      }
      if(result.sectionGrades&&typeof result.sectionGrades==="object"){
        sectionGrades=result.sectionGrades;
        populateSectionControls(activeStudentSection);
      }
      renderStudents(rosterStudents);
      try{
        var removedEClassScores=reconcileEClassScoresWithRoster(rosterStudents);
        if(removedEClassScores){
          $("studentNotice").textContent="Roster refreshed. Cleared saved E-Class inputs for "+removedEClassScores
            +" student"+(removedEClassScores===1?"":"s")+" no longer on this roster.";
        }
      }catch(error){
        $("studentNotice").textContent="Roster refreshed, but saved E-Class inputs could not be reconciled: "+error.message;
        $("studentNotice").classList.add("error");
      }
      return true;
    }catch(error){
      $("studentCount").textContent="Unable to load";
      $("clearStudentRoster").disabled=true;
      $("studentNotice").textContent=error.message;
      $("studentNotice").classList.add("error");
      return false;
    }
  }

  function nutritionalAssessmentForStudent(student,cycle){
    if(student.nutritionalAssessments&&student.nutritionalAssessments[cycle]){
      return student.nutritionalAssessments[cycle];
    }
    if(cycle==="BOSY")return student;
    return {measurementDate:"",weightKg:"",heightM:"",heightSquaredM2:null,bmi:null,
      bmiCategory:"",heightForAgeStatus:""};
  }

  async function loadNutritionalStatusRoster(){
    var measurementDateInput=$("nutritionalMeasurementDate");
    var today=localISODate();
    var cycle=nutritionalAssessmentCycle;
    $("exportSF8").disabled=true;
    $("editNutritionalMeasurements").disabled=true;
    $("editNutritionalMeasurements").textContent="Edit Measurements";
    $("editNutritionalMeasurements").dataset.editing="false";
    $("saveNutritionalMeasurements").disabled=true;
    if(!measurementDateInput.value)measurementDateInput.value=today;
    measurementDateInput.max=today;
    $("nutritionalRosterNotice").textContent="";
    $("nutritionalRosterNotice").classList.remove("error");
    $("nutritionalRosterCount").textContent="Loading students...";
    $("nutritionalRosterTable").hidden=true;
    $("nutritionalRosterEmpty").hidden=true;
    $("nutritionalRosterRows").replaceChildren();
    try{
      var result=await api("/api/students");
      if(!Array.isArray(result.students)){
        throw new Error("The roster response is outdated. Restart the portal server to load the updated backend.");
      }
      result.students=filterStudentsForActiveSection(result.students);
      var missingWhoResults=result.students.some(function(student){
        var assessment=nutritionalAssessmentForStudent(student,cycle);
        return assessment.measurementDate
          &&(typeof assessment.bmiCategory!=="string"||!assessment.bmiCategory
            ||typeof assessment.heightForAgeStatus!=="string"||!assessment.heightForAgeStatus);
      });
      var firstMeasurementDate=result.students.map(function(student){
        return nutritionalAssessmentForStudent(student,cycle).measurementDate;
      }).find(Boolean);
      measurementDateInput.value=nutritionalAssessmentDates[cycle]||firstMeasurementDate||today;
      nutritionalAssessmentDates[cycle]=measurementDateInput.value;
      $("nutritionalRosterCount").textContent=result.students.length+" student"+(result.students.length===1?"":"s");
      if(missingWhoResults){
        $("nutritionalRosterNotice").textContent="The running portal server is outdated and did not return both WHO classifications. Restart the portal server, then refresh this roster.";
      }
      $("nutritionalRosterEmpty").hidden=result.students.length!==0;
      $("nutritionalRosterTable").hidden=result.students.length===0;
      measurementDateInput.onchange=function(){
        nutritionalAssessmentDates[cycle]=measurementDateInput.value;
        $("nutritionalRosterRows").querySelectorAll("tr").forEach(function(row){
          if(!row.dataset.measurementDate){
            row.querySelector('[data-nutritional-age="true"]').textContent=
              nutritionalStudentAge(row.dataset.birthdate,measurementDateInput.value);
          }
        });
      };
      result.students.forEach(function(student,index){
        var assessment=nutritionalAssessmentForStudent(student,cycle);
        var row=document.createElement("tr");
        row.dataset.studentId=student.id;
        row.dataset.studentName=student.name;
        row.dataset.assessmentCycle=cycle;
        appendTextCell(row,String(index+1));
        appendTextCell(row,[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", "));
        appendTextCell(row,student.gender);
        appendTextCell(row,student.birthdate);
        var ageCell=appendTextCell(
          row,
          nutritionalStudentAge(student.birthdate,assessment.measurementDate||measurementDateInput.value),
        );
        ageCell.dataset.nutritionalAge="true";
        row.dataset.birthdate=student.birthdate||"";
        row.dataset.measurementDate=assessment.measurementDate||"";
        row.dataset.savedWeightKg=assessment.weightKg?String(assessment.weightKg):"";
        row.dataset.savedHeightM=assessment.heightM?String(assessment.heightM):"";
        var weightCell=appendTextCell(row,"");
        var weightInput=document.createElement("input");
        weightInput.className="nutritional-measurement-input";
        weightInput.type="number";
        weightInput.min="0.01";
        weightInput.max="500";
        weightInput.step="0.01";
        weightInput.inputMode="decimal";
        weightInput.setAttribute("aria-label","Weight in kilograms for "+student.name);
        weightInput.dataset.measurement="weightKg";
        weightInput.value=assessment.weightKg||"";
        weightInput.disabled=false;
        weightCell.replaceChildren(weightInput);
        var heightCell=appendTextCell(row,"");
        var heightInput=document.createElement("input");
        heightInput.className="nutritional-measurement-input";
        heightInput.type="number";
        heightInput.min="0.001";
        heightInput.max="2.5";
        heightInput.step="0.001";
        heightInput.inputMode="decimal";
        heightInput.setAttribute("aria-label","Height in meters for "+student.name);
        heightInput.dataset.measurement="heightM";
        heightInput.value=assessment.heightM||"";
        heightInput.disabled=false;
        heightCell.replaceChildren(heightInput);
        var heightSquaredCell=appendTextCell(row,formatNutritionalValue(student.heightSquaredM2,4));
        heightSquaredCell.dataset.calculation="heightSquared";
        var bmiCell=appendTextCell(row,formatNutritionalValue(student.bmi,2));
        bmiCell.dataset.calculation="bmi";
        var hasMeasurements=assessment.weightKg&&assessment.heightM;
        var bmiCategory=assessment.measurementDate
          ?assessment.bmiCategory||"Restart server"
          :hasMeasurements?"Save to calculate":"Enter measurements";
        var bmiCategoryCell=appendTextCell(row,bmiCategory);
        bmiCategoryCell.dataset.calculation="bmiCategory";
        var heightForAgeCell=appendTextCell(
          row,
          assessment.measurementDate?assessment.heightForAgeStatus||"Restart server"
            :hasMeasurements?"Save to calculate":"Enter measurements",
        );
        heightForAgeCell.dataset.calculation="heightForAge";
        row.dataset.measurementsLocked=assessment.measurementDate?"true":"false";
        if(assessment.measurementDate){
          weightInput.disabled=true;
          heightInput.disabled=true;
        }
        [weightInput,heightInput].forEach(function(input){
          function handleMeasurementChange(){
            row.dataset.measurementsChanged="true";
            updateNutritionalCalculations(row);
            updateNutritionalSaveButton();
          }
          input.addEventListener("input",handleMeasurementChange);
          input.addEventListener("change",handleMeasurementChange);
        });
        $("nutritionalRosterRows").appendChild(row);
        updateNutritionalCalculations(row);
      });
      updateNutritionalSaveButton();
    }catch(error){
      $("nutritionalRosterCount").textContent="Unable to load";
      $("nutritionalRosterNotice").textContent=error.message;
      $("nutritionalRosterNotice").classList.add("error");
    }
  }

  function selectNutritionalCycle(cycle,focusTab){
    if((cycle!=="BOSY"&&cycle!=="EOSY")||cycle===nutritionalAssessmentCycle
      ||nutritionalMeasurementsSaving||nutritionalStatusExporting)return;
    var rows=Array.from($("nutritionalRosterRows").querySelectorAll("tr"));
    var editButton=$("editNutritionalMeasurements");
    var hasEdits=editButton.dataset.editing==="true"||rows.some(hasNutritionalMeasurementsChanged);
    if(hasEdits&&!window.confirm("Discard unsaved nutritional measurements for "+nutritionalAssessmentCycle+"?"))return;
    if(editButton.dataset.editing==="true")toggleNutritionalMeasurementsEditing();
    nutritionalAssessmentCycle=cycle;
    var isBosy=cycle==="BOSY";
    var tab=isBosy?$("nutritionalBosyTab"):$("nutritionalEosyTab");
    $("nutritionalBosyTab").setAttribute("aria-selected",String(isBosy));
    $("nutritionalEosyTab").setAttribute("aria-selected",String(!isBosy));
    $("nutritionalBosyTab").tabIndex=isBosy?0:-1;
    $("nutritionalEosyTab").tabIndex=isBosy?-1:0;
    $("nutritionalAssessmentPanel").setAttribute("aria-labelledby",tab.id);
    $("nutritionalMeasurementDateLabelText").textContent=
      "Date of "+cycle+" weighing and measurement";
    $("nutritionalRosterHeading").textContent=cycle+" students";
    if(focusTab)tab.focus();
    loadNutritionalStatusRoster();
  }

  function setNutritionalMeasurementsLocked(row,locked){
    var weightInput=row.querySelector('[data-measurement="weightKg"]');
    var heightInput=row.querySelector('[data-measurement="heightM"]');
    row.dataset.measurementsLocked=String(locked);
    weightInput.disabled=locked;
    heightInput.disabled=locked;
  }

  function hasNutritionalMeasurementsChanged(row){
    if(row.dataset.measurementsLocked==="true")return false;
    var weightInput=row.querySelector('[data-measurement="weightKg"]');
    var heightInput=row.querySelector('[data-measurement="heightM"]');
    return row.dataset.measurementsChanged==="true"
      ||weightInput.value!==row.dataset.savedWeightKg
      ||heightInput.value!==row.dataset.savedHeightM;
  }

  var nutritionalMeasurementsSaving=false;
  var nutritionalStatusExporting=false;

  function updateNutritionalSaveButton(){
    var rows=$("nutritionalRosterRows");
    var hasUnsavedMeasurements=Array.from(rows.querySelectorAll("tr"))
      .some(hasNutritionalMeasurementsChanged);
    var hasStudents=rows.querySelectorAll("tr").length>0;
    var editButton=$("editNutritionalMeasurements");
    var allRows=Array.from(rows.querySelectorAll("tr"));
    var hasSavedMeasurements=allRows.some(function(row){return Boolean(row.dataset.measurementDate)});
    var editingSavedMeasurements=allRows.some(function(row){
      return row.dataset.editSnapshot==="true"&&row.dataset.measurementsLocked!=="true";
    });
    editButton.dataset.editing=String(editingSavedMeasurements);
    editButton.disabled=
      nutritionalMeasurementsSaving||nutritionalStatusExporting||(!hasSavedMeasurements&&!editingSavedMeasurements);
    editButton.textContent=editingSavedMeasurements?"Cancel Edits":"Edit Measurements";
    $("saveNutritionalMeasurements").disabled=
      nutritionalMeasurementsSaving||nutritionalStatusExporting||!hasUnsavedMeasurements;
    $("exportSF8").disabled=
      nutritionalMeasurementsSaving||nutritionalStatusExporting||!hasStudents||hasUnsavedMeasurements;
  }

  function formatNutritionalValue(value,decimalPlaces){
    return typeof value==="number"&&Number.isFinite(value)?value.toFixed(decimalPlaces):"";
  }

  function updateNutritionalCalculations(row){
    var weight=Number(row.querySelector('[data-measurement="weightKg"]').value);
    var height=Number(row.querySelector('[data-measurement="heightM"]').value);
    var heightSquaredCell=row.querySelector('[data-calculation="heightSquared"]');
    var bmiCell=row.querySelector('[data-calculation="bmi"]');
    var bmiCategoryCell=row.querySelector('[data-calculation="bmiCategory"]');
    var heightForAgeCell=row.querySelector('[data-calculation="heightForAge"]');
    if(!Number.isFinite(height)||height<=0){
      heightSquaredCell.textContent="";
      bmiCell.textContent="";
      bmiCategoryCell.textContent="Enter measurements";
      heightForAgeCell.textContent="Enter measurements";
      return;
    }
    var heightSquared=height**2;
    heightSquaredCell.textContent=formatNutritionalValue(heightSquared,4);
    bmiCell.textContent=Number.isFinite(weight)&&weight>0
      ?formatNutritionalValue(weight/heightSquared,2)
      :"";
    if(row.dataset.measurementsChanged==="true"){
      var savePrompt=row.dataset.measurementDate?"Save to update":"Save to calculate";
      bmiCategoryCell.textContent=savePrompt;
      heightForAgeCell.textContent=savePrompt;
    }
  }

  function validateNutritionalMeasurements(row){
    var measurementDateInput=$("nutritionalMeasurementDate");
    var weightInput=row.querySelector('[data-measurement="weightKg"]');
    var heightInput=row.querySelector('[data-measurement="heightM"]');
    var weightKg=Number(weightInput.value);
    var heightM=Number(heightInput.value);
    if(!measurementDateInput.value){
      measurementDateInput.setCustomValidity("Enter the date the learner was weighed and measured.");
      measurementDateInput.reportValidity();
      measurementDateInput.setCustomValidity("");
      return false;
    }
    if(!weightInput.value||!Number.isFinite(weightKg)||weightKg<=0||weightKg>500){
      weightInput.setCustomValidity("Enter a weight greater than 0 and no more than 500 kg.");
      weightInput.reportValidity();
      weightInput.setCustomValidity("");
      return false;
    }
    if(!heightInput.value||!Number.isFinite(heightM)||heightM<=0||heightM>2.5){
      heightInput.setCustomValidity("Enter a height greater than 0 and no more than 2.5 m.");
      heightInput.reportValidity();
      heightInput.setCustomValidity("");
      return false;
    }
    return true;
  }

  async function saveNutritionalMeasurements(row){
    if(!validateNutritionalMeasurements(row))return {error:"Complete the required measurement fields."};
    var measurementDate=$("nutritionalMeasurementDate").value;
    var weightInput=row.querySelector('[data-measurement="weightKg"]');
    var heightInput=row.querySelector('[data-measurement="heightM"]');
    var weightKg=Number(weightInput.value);
    var heightM=Number(heightInput.value);
    try{
      var result=await api("/api/students/"+encodeURIComponent(row.dataset.studentId)+"/nutritional-status",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          cycle:row.dataset.assessmentCycle,
          measurementDate:measurementDate,
          weightKg:weightKg,
          heightM:heightM
        })
      });
      weightInput.value=String(result.weightKg);
      heightInput.value=String(result.heightM);
      row.dataset.savedWeightKg=weightInput.value;
      row.dataset.savedHeightM=heightInput.value;
      row.dataset.measurementDate=result.measurementDate;
      nutritionalAssessmentDates[row.dataset.assessmentCycle]=result.measurementDate;
      row.dataset.measurementsChanged="false";
      delete row.dataset.editSnapshot;
      var hasWhoResults=typeof result.bmiCategory==="string"&&result.bmiCategory
        &&typeof result.heightForAgeStatus==="string"&&result.heightForAgeStatus;
      row.dataset.whoResultsMissing=hasWhoResults?"false":"true";
      row.querySelector('[data-calculation="bmiCategory"]').textContent=
        hasWhoResults?result.bmiCategory:"Restart server";
      row.querySelector('[data-calculation="heightForAge"]').textContent=
        hasWhoResults?result.heightForAgeStatus:"Restart server";
      row.querySelector('[data-nutritional-age="true"]').textContent=
        nutritionalStudentAge(row.dataset.birthdate,result.measurementDate);
      updateNutritionalCalculations(row);
      setNutritionalMeasurementsLocked(row,true);
      return {hasWhoResults:Boolean(hasWhoResults)};
    }catch(error){
      return {error:error.message};
    }
  }

  async function saveAllNutritionalMeasurements(){
    var changedRows=Array.from($("nutritionalRosterRows").querySelectorAll("tr"))
      .filter(hasNutritionalMeasurementsChanged);
    if(!changedRows.length)return;
    for(var row of changedRows){
      if(!validateNutritionalMeasurements(row))return;
    }
    var saveButton=$("saveNutritionalMeasurements");
    var measurementDateInput=$("nutritionalMeasurementDate");
    var refreshButton=$("refreshNutritionalRoster");
    var rowControls=$("nutritionalRosterRows").querySelectorAll("input,button");
    nutritionalMeasurementsSaving=true;
    updateNutritionalSaveButton();
    rowControls.forEach(function(control){control.disabled=true});
    measurementDateInput.disabled=true;
    refreshButton.disabled=true;
    saveButton.disabled=true;
    saveButton.textContent="Saving...";
    saveButton.setAttribute("aria-busy","true");
    $("nutritionalRosterNotice").textContent="";
    $("nutritionalRosterNotice").classList.remove("error");
    var errors=[];
    var missingWhoResults=false;
    var savedCount=0;
    try{
      for(var changedRow of changedRows){
        var result=await saveNutritionalMeasurements(changedRow);
        if(result.error){
          errors.push(changedRow.dataset.studentName+": "+result.error);
        }else{
          savedCount+=1;
          missingWhoResults=missingWhoResults||!result.hasWhoResults;
        }
      }
      if(errors.length){
        $("nutritionalRosterNotice").textContent=
          (savedCount?savedCount+" student measurement(s) saved and locked. ":"")
          +"Could not save: "+errors.join("; ");
        $("nutritionalRosterNotice").classList.add("error");
      }else if(missingWhoResults){
        $("nutritionalRosterNotice").textContent=
          "Measurements saved and locked, but the running portal server did not return both WHO classifications. Restart the server, then refresh this roster.";
      }else{
        $("nutritionalRosterNotice").textContent=
          "Measurements saved and locked for "+savedCount+" student"+(savedCount===1?"":"s")+".";
      }
    }finally{
      $("nutritionalRosterRows").querySelectorAll("input,button").forEach(function(control){
        if(control.matches("input")){
          var row=control.closest("tr");
          control.disabled=row.dataset.measurementsLocked==="true";
        }else{
          control.disabled=false;
        }
      });
      nutritionalMeasurementsSaving=false;
      measurementDateInput.disabled=false;
      refreshButton.disabled=false;
      updateNutritionalSaveButton();
      saveButton.textContent="Save and Lock";
      saveButton.removeAttribute("aria-busy");
    }
  }

  function toggleNutritionalMeasurementsEditing(){
    var editButton=$("editNutritionalMeasurements");
    if(editButton.disabled||nutritionalMeasurementsSaving||nutritionalStatusExporting)return;
    var rows=Array.from($("nutritionalRosterRows").querySelectorAll("tr"));
    if(editButton.dataset.editing!=="true"){
      rows.forEach(function(row){
        if(!row.dataset.measurementDate||row.dataset.measurementsLocked!=="true")return;
        row.dataset.originalWeightKg=row.querySelector('[data-measurement="weightKg"]').value;
        row.dataset.originalHeightM=row.querySelector('[data-measurement="heightM"]').value;
        row.dataset.originalBmiCategory=row.querySelector('[data-calculation="bmiCategory"]').textContent;
        row.dataset.originalHeightForAge=row.querySelector('[data-calculation="heightForAge"]').textContent;
        row.dataset.editSnapshot="true";
        setNutritionalMeasurementsLocked(row,false);
      });
      editButton.dataset.editing="true";
      updateNutritionalSaveButton();
      return;
    }
    rows.forEach(function(row){
      if(row.dataset.editSnapshot!=="true")return;
      row.querySelector('[data-measurement="weightKg"]').value=row.dataset.originalWeightKg;
      row.querySelector('[data-measurement="heightM"]').value=row.dataset.originalHeightM;
      row.dataset.measurementsChanged="false";
      delete row.dataset.editSnapshot;
      setNutritionalMeasurementsLocked(row,true);
      updateNutritionalCalculations(row);
      row.querySelector('[data-calculation="bmiCategory"]').textContent=row.dataset.originalBmiCategory;
      row.querySelector('[data-calculation="heightForAge"]').textContent=row.dataset.originalHeightForAge;
    });
    editButton.dataset.editing="false";
    updateNutritionalSaveButton();
  }

  async function exportNutritionalStatusSF8(){
    var button=$("exportSF8");
    if(button.disabled||nutritionalMeasurementsSaving)return;
    nutritionalStatusExporting=true;
    updateNutritionalSaveButton();
    var rowControls=$("nutritionalRosterRows").querySelectorAll("input,button");
    rowControls.forEach(function(control){control.disabled=true});
    $("nutritionalMeasurementDate").disabled=true;
    button.disabled=true;
    button.textContent="Preparing SF8...";
    button.setAttribute("aria-busy","true");
    $("refreshNutritionalRoster").disabled=true;
    $("nutritionalRosterNotice").textContent="";
    $("nutritionalRosterNotice").classList.remove("error");
    try{
      var assessmentDate=$("nutritionalMeasurementDate").value;
      var assessmentParams=new URLSearchParams();
      assessmentParams.set("cycle",nutritionalAssessmentCycle);
      if(assessmentDate)assessmentParams.set("assessmentDate",assessmentDate);
      if(activeStudentSection!=="__all__")assessmentParams.set("section",activeStudentSection);
      var assessmentQuery=assessmentParams.toString()?"?"+assessmentParams.toString():"";
      var response=await fetch("/api/students/nutritional-status/sf8"+assessmentQuery);
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to export the SF8 report.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var filenameMatch=disposition.match(/filename="([^"]+)"/i);
      if(!filenameMatch)throw new Error("The server did not provide an SF8 filename.");
      var generatedPath=response.headers.get("x-generated-file-path");
      if(!generatedPath)throw new Error("The server did not provide the saved SF8 file location.");
      var incompleteMeasurementCount=Number(response.headers.get("x-incomplete-measurement-count")||"0");
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=filenameMatch[1];
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      $("nutritionalRosterNotice").textContent="SF8 generated and downloaded. Saved to "+generatedPath
        +(incompleteMeasurementCount
          ?". "+incompleteMeasurementCount+" learner(s) have incomplete nutritional measurements; unavailable cells are blank."
          :"");
    }catch(error){
      $("nutritionalRosterNotice").textContent=error.message;
      $("nutritionalRosterNotice").classList.add("error");
    }finally{
      button.textContent="Generate SF8";
      button.removeAttribute("aria-busy");
      $("nutritionalRosterRows").querySelectorAll("input,button").forEach(function(control){
        if(control.matches("input")){
          var row=control.closest("tr");
          control.disabled=row.dataset.measurementsLocked==="true";
        }else{
          control.disabled=false;
        }
      });
      nutritionalStatusExporting=false;
      $("nutritionalMeasurementDate").disabled=false;
      $("refreshNutritionalRoster").disabled=false;
      updateNutritionalSaveButton();
    }
  }

  function nutritionalStudentAge(birthdate,measurementDate){
    function parseDate(value){
      if(typeof value!=="string"||! /^\d{4}-\d{2}-\d{2}$/.test(value))return null;
      var parts=value.split("-").map(Number);
      var date=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
      if(Number.isNaN(date.getTime())
        ||date.getUTCFullYear()!==parts[0]
        ||date.getUTCMonth()!==parts[1]-1
        ||date.getUTCDate()!==parts[2])return null;
      return date;
    }
    var birth=parseDate(birthdate);
    var measured=parseDate(measurementDate);
    if(!birth||!measured||measured<birth)return "";
    var age=measured.getUTCFullYear()-birth.getUTCFullYear();
    if(measured.getUTCMonth()<birth.getUTCMonth()
      ||(measured.getUTCMonth()===birth.getUTCMonth()
        &&measured.getUTCDate()<birth.getUTCDate()))age-=1;
    return String(age);
  }

  function renderNoClassSummary(result){
    var list=$("attendanceNoClassList");
    list.replaceChildren();
    var dates=result.noClassDates.slice().sort();
    $("attendanceNoClassSummary").hidden=dates.length===0;
    dates.forEach(function(date){
      var item=document.createElement("li");
      var day=document.createElement("b");
      day.textContent=new Date(date+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric",weekday:"short"});
      item.appendChild(day);
      var reason=String(result.noClassReasons[date]||"").trim();
      var text=document.createElement("em");
      text.textContent=" — "+(reason||"No reason entered");
      item.appendChild(text);
      list.appendChild(item);
    });
  }

  function renderAttendance(result){
    var rosterStudents=Array.isArray(result.students)?result.students.filter(function(student){
      return student && student.id && String(student.name||"").trim();
    }):[];
    result.students=rosterStudents;
    if(!Array.isArray(result.noClassDates))result.noClassDates=[];
    if(!result.noClassReasons||typeof result.noClassReasons!=="object")result.noClassReasons={};
    $("clearAttendanceMonth").disabled=rosterStudents.length===0;
    $("clearAttendanceMonth").title="Clear attendance within the school-year dates for the entire class and month.";
    $("attendanceRows").replaceChildren();
    $("attendanceTotals").replaceChildren();
    $("attendanceCount").textContent=String(rosterStudents.filter(function(s){return !inactiveStudentIds.has(s.id)}).length);
    $("attendanceSavedDays").textContent=String(countClassDays(result));
    renderNoClassSummary(result);
    $("attendanceTable").hidden=rosterStudents.length===0;
    $("attendanceEmpty").hidden=rosterStudents.length!==0;
    var monthDate=new Date(result.month+"-01T00:00:00");
    $("attendanceMonthTitle").textContent=monthDate.toLocaleDateString(undefined,{month:"long",year:"numeric"})+" attendance record";
    var now=new Date();
    var todayDate=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0");
    var todayIndex=result.month===todayDate.slice(0,7)?result.dates.indexOf(todayDate):-1;
    var firstHeaderRow=document.createElement("tr");
    var secondHeaderRow=document.createElement("tr");
    var thirdHeaderRow=document.createElement("tr");
    var numberHeader=document.createElement("th");
    numberHeader.className="attendance-number";
    numberHeader.rowSpan=3;
    numberHeader.textContent="#";
    var learnerHeader=document.createElement("th");
    learnerHeader.className="attendance-learner";
    learnerHeader.rowSpan=3;
    learnerHeader.textContent="Name of Pupil";
    firstHeaderRow.append(numberHeader,learnerHeader);
    result.dates.forEach(function(date,index){
      var dayHeader=document.createElement("th");
      dayHeader.className="attendance-day";
      dayHeader.dataset.attendanceDate=date;
      dayHeader.textContent=String(Number(date.slice(-2)));
      dayHeader.title=new Date(date+"T00:00:00").toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
      if(result.noClassDates.includes(date)){
        dayHeader.classList.add("attendance-no-class");
        dayHeader.title+=" — Holiday/No Class"+(result.noClassReasons[date]?": "+result.noClassReasons[date]:"");
      }
      if(date===todayDate){
        dayHeader.classList.add("attendance-today");
        dayHeader.title+=" — Today";
      }
      firstHeaderRow.appendChild(dayHeader);
      var weekdayHeader=document.createElement("th");
      weekdayHeader.className="attendance-weekday";
      weekdayHeader.textContent=new Date(date+"T00:00:00").toLocaleDateString(undefined,{weekday:"short"});
      if(date===todayDate)weekdayHeader.classList.add("attendance-today");
      secondHeaderRow.appendChild(weekdayHeader);
      var dayTypeCell=document.createElement("th");
      dayTypeCell.className="attendance-day-type-cell";
      var dayTypeSelect=document.createElement("select");
      dayTypeSelect.className="attendance-day-type";
      dayTypeSelect.setAttribute("aria-label","Class schedule for "+new Date(date+"T00:00:00").toLocaleDateString(undefined,{month:"long",day:"numeric"}));
      dayTypeSelect.add(new Option("Class Day","class"));
      dayTypeSelect.add(new Option("Holiday/No Class","no-class"));
      dayTypeSelect.value=result.noClassDates.includes(date)?"no-class":"class";
      dayTypeCell.appendChild(dayTypeSelect);
      var reasonInput=document.createElement("input");
      reasonInput.type="text";
      reasonInput.className="attendance-no-class-reason";
      reasonInput.maxLength=80;
      reasonInput.placeholder="Reason / holiday";
      reasonInput.setAttribute("aria-label","Reason for no class on "+new Date(date+"T00:00:00").toLocaleDateString(undefined,{month:"long",day:"numeric"}));
      reasonInput.value=result.noClassReasons[date]||"";
      reasonInput.hidden=!result.noClassDates.includes(date);
      dayTypeCell.appendChild(reasonInput);
      thirdHeaderRow.appendChild(dayTypeCell);
      reasonInput.addEventListener("input",function(){
        result.noClassReasons[date]=reasonInput.value;
        dayHeader.title=new Date(date+"T00:00:00").toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"})
          +" — Holiday/No Class"+(reasonInput.value.trim()?": "+reasonInput.value.trim():"");
        attendanceDirty=true;
        renderNoClassSummary(result);
      });
      var stashedMarks={};
      dayTypeSelect.addEventListener("change",function(){
        var noClassDates=new Set(result.noClassDates);
        var isNoClass=dayTypeSelect.value==="no-class";
        if(isNoClass)noClassDates.add(date);
        else noClassDates.delete(date);
        result.noClassDates=Array.from(noClassDates);
        if(attendanceData)attendanceData.noClassDates=result.noClassDates;
        reasonInput.hidden=!isNoClass;
        if(isNoClass)reasonInput.focus();
        else{reasonInput.value="";delete result.noClassReasons[date]}
        $("attendanceSavedDays").textContent=String(countClassDays(result));
        var restored={};
        (attendanceData?attendanceData.students:result.students).forEach(function(student){
          if(isNoClass){
            if(student.attendance[index])stashedMarks[student.id]={status:student.attendance[index],reason:student.reasons[index]||""};
            student.attendance[index]="";
            student.reasons[index]="";
          }else{
            var saved=stashedMarks[student.id];
            student.attendance[index]=saved?saved.status:"Present";
            student.reasons[index]=saved?saved.reason:"";
            restored[student.id]=saved||{status:"Present",reason:""};
          }
        });
        if(!isNoClass)stashedMarks={};
        document.querySelectorAll("#attendanceRows [data-day-index=\""+index+"\"]").forEach(function(control){
          var mark=restored[control.dataset.studentId]||{status:"Present",reason:""};
          if(control.classList.contains("attendance-no-class-mark")){
            control.hidden=!isNoClass;
          }else if(control.tagName==="SELECT"){
            control.value=isNoClass?"":mark.status;
            control.hidden=isNoClass;
          }else if(control.classList.contains("attendance-reason-input")){
            control.value=isNoClass?"":mark.reason;
            control.hidden=isNoClass||!hasReason(mark.status);
            control.required=false;
          }
          var studentRecord=result.students.find(function(student){return student.id===control.dataset.studentId});
          var isStatusLocked=studentRecord&&studentRecord.lockedDates.includes(date);
          control.disabled=isNoClass||Boolean(isStatusLocked);
        });
        document.querySelectorAll("#attendanceRows td[data-day-index=\""+index+"\"],#attendanceTotals td[data-day-index=\""+index+"\"]")
          .forEach(function(cell){cell.classList.toggle("attendance-no-class-cell",isNoClass)});
        dayHeader.classList.toggle("attendance-no-class",isNoClass);
        dayHeader.title=new Date(date+"T00:00:00").toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"})
          +(isNoClass?" — Holiday/No Class":"");
        attendanceDirty=true;
        $("attendanceNotice").textContent="";
        $("attendanceNotice").classList.remove("error");
        refreshAllSummaryRows();
        renderNoClassSummary(result);
      });
    });
    var monthTotalHeader=document.createElement("th");
    monthTotalHeader.colSpan=3;
    monthTotalHeader.rowSpan=1;
    monthTotalHeader.textContent="TOTAL FOR THE MONTH";
    firstHeaderRow.appendChild(monthTotalHeader);
    ["PRESENT","ABSENT","TARDY"].forEach(function(status){
      var totalHeader=document.createElement("th");
      totalHeader.className="attendance-total";
      totalHeader.textContent=status;
      secondHeaderRow.appendChild(totalHeader);
    });
    var remarksHeader=document.createElement("th");
    remarksHeader.className="attendance-remarks";
    remarksHeader.rowSpan=3;
    remarksHeader.textContent="MONTHLY STATUS / EFFECTIVE DATE";
    firstHeaderRow.appendChild(remarksHeader);
    ["PRESENT","ABSENT","TARDY"].forEach(function(){
      thirdHeaderRow.appendChild(document.createElement("th"));
    });
    $("attendanceHead").replaceChildren(firstHeaderRow,secondHeaderRow,thirdHeaderRow);

    var groups=[
      {name:"MALE",students:rosterStudents.filter(function(student){return student.gender==="Male"})},
      {name:"FEMALE",students:rosterStudents.filter(function(student){return student.gender==="Female"})},
      {name:"OTHER",students:rosterStudents.filter(function(student){return student.gender!=="Male"&&student.gender!=="Female"})}
    ].filter(function(group){return group.students.length>0});
    var statusKeys=["Present","Absent","Tardy"];
    function isAttendanceAbsent(status){return status==="Absent"||status==="AbsentX"}
    function totalsFor(students){
      var totals={Present:0,Absent:0,Tardy:0};
      students.forEach(function(student){
        student.attendance.forEach(function(status){
          if(status==="Present"||status==="Tardy")totals.Present+=1;
          else if(isAttendanceAbsent(status))totals.Absent+=1;
          if(status==="Tardy")totals.Tardy+=1;
        });
      });
      return totals;
    }
    function updateStatusLocks(student,row){
      if(student.remarks==="Transferred In"&&!student.statusInherited&&student.statusDate){
        student.lockedDates=result.dates.filter(function(date){return date<student.statusDate});
      }else{
        student.lockedDates=(student.statusBaselineLockedDates||[]).slice();
      }
      student.attendanceLocked=student.lockedDates.length===result.dates.length;
      result.dates.forEach(function(date,index){
        var locked=student.lockedDates.includes(date);
        if(locked){
          student.attendance[index]="";
          student.reasons[index]="";
        }else if(student.attendance[index]===""&&isDefaultPresentDate(result,date,null)){
          student.attendance[index]="Present";
        }
        var select=Array.from(row.querySelectorAll(".attendance-day-select")).find(function(control){
          return Number(control.dataset.dayIndex)===index;
        });
        var reasonInput=Array.from(row.querySelectorAll(".attendance-reason-input")).find(function(control){
          return Number(control.dataset.dayIndex)===index;
        });
        if(select){
          select.value=student.attendance[index];
          select.disabled=locked||result.noClassDates.includes(date);
        }
        if(reasonInput){
          reasonInput.value=student.reasons[index]||"";
          reasonInput.hidden=!hasReason(student.attendance[index]);
          reasonInput.required=false;
          reasonInput.placeholder=reasonPlaceholder(student.attendance[index]);
          reasonInput.disabled=locked||result.noClassDates.includes(date);
        }
      });
      var totals=totalsFor([student]);
      statusKeys.forEach(function(status){
        var cell=row.querySelector('[data-total="'+status+'"]');
        if(cell)cell.textContent=String(totals[status]);
      });
      var badge=row.querySelector(".attendance-status-badge");
      if(["NLS","Transferred Out","Transferred In"].includes(student.remarks)){
        if(!badge){
          badge=document.createElement("span");
          badge.className="attendance-status-badge";
          row.querySelector(".attendance-learner").appendChild(badge);
        }
        badge.textContent=student.remarks+(student.statusDate?" · "+student.statusDate:"")
          +(student.attendanceLocked?" · attendance locked":"");
      }else if(badge){
        badge.remove();
      }
      refreshAllSummaryRows();
    }
    function appendSummaryRow(target,label,students,className){
      var row=document.createElement("tr");
      row.className=className;
      row.dataset.summaryGroup=label;
      var labelCell=document.createElement("th");
      labelCell.colSpan=2;
      labelCell.scope="row";
      labelCell.textContent=label+" | TOTAL PER DAY";
      row.appendChild(labelCell);
      result.dates.forEach(function(date,index){
        var cell=document.createElement("td");
        var daily={Present:0,Absent:0,Tardy:0};
        students.forEach(function(student){
          var status=student.attendance[index];
          if(status==="Present")daily.Present+=1;
          else if(isAttendanceAbsent(status))daily.Absent+=1;
          if(status==="Tardy")daily.Tardy+=1;
        });
        cell.className="attendance-tally";
        cell.dataset.dayIndex=String(index);
        if(result.noClassDates.includes(date)){
          cell.classList.add("attendance-no-class-cell");
          cell.textContent="NC";
        }
        if(date===todayDate)cell.classList.add("attendance-today");
        if(!result.noClassDates.includes(date))cell.textContent=daily.Present?String(daily.Present):"";
        cell.title=result.noClassDates.includes(date)
          ?"NC — No Class"
          :"Present: "+daily.Present+", Absent: "+daily.Absent+", Tardy: "+daily.Tardy;
        row.appendChild(cell);
      });
      var totals=totalsFor(students);
      statusKeys.forEach(function(status){
        var cell=document.createElement("td");
        cell.className="attendance-total";
        cell.textContent=String(totals[status]);
        row.appendChild(cell);
      });
      var remarksCell=document.createElement("td");
      remarksCell.className="attendance-remarks";
      row.appendChild(remarksCell);
      target.appendChild(row);
    }
    function refreshSummaryRow(label,students){
      var row=Array.from(document.querySelectorAll("#attendanceRows tr[data-summary-group],#attendanceTotals tr[data-summary-group]"))
        .find(function(candidate){return candidate.dataset.summaryGroup===label});
      if(!row)return;
      result.dates.forEach(function(date,index){
        var daily={Present:0,Absent:0,Tardy:0};
        students.forEach(function(student){
          var status=student.attendance[index];
          if(status==="Present")daily.Present+=1;
          else if(isAttendanceAbsent(status))daily.Absent+=1;
          if(status==="Tardy")daily.Tardy+=1;
        });
        var cell=row.cells[index+1];
        if(result.dates[index]===todayDate)cell.classList.add("attendance-today");
        var isNoClass=result.noClassDates.includes(date);
        cell.classList.toggle("attendance-no-class-cell",isNoClass);
        cell.textContent=isNoClass?"NC":(daily.Present?String(daily.Present):"");
        cell.title=isNoClass
          ?"NC — No Class"
          :"Present: "+daily.Present+", Absent: "+daily.Absent+", Tardy: "+daily.Tardy;
      });
      var totals=totalsFor(students);
      statusKeys.forEach(function(status,index){
        row.cells[result.dates.length+1+index].textContent=String(totals[status]);
      });
    }
    function refreshAllSummaryRows(){
      groups.forEach(function(group){refreshSummaryRow(group.name,group.students)});
      refreshSummaryRow("COMBINED",rosterStudents);
      paintAttendanceSelects();
    }

    groups.forEach(function(group){
      group.students.forEach(function(student,index){
      var row=document.createElement("tr");
      var number=document.createElement("td");
      number.className="attendance-number";
      number.textContent=String(index+1);
      row.appendChild(number);
      var name=document.createElement("td");
      name.className="attendance-learner";
      name.textContent=student.name;
      var statusBadge=null;
      if(["NLS","Transferred Out","Transferred In"].includes(student.remarks)){
        statusBadge=document.createElement("span");
        statusBadge.className="attendance-status-badge";
        statusBadge.textContent=student.remarks+(student.statusDate?" · "+student.statusDate:"")
          +(student.attendanceLocked?" · attendance locked":"");
        name.appendChild(statusBadge);
      }
      row.appendChild(name);
      var studentTotals=totalsFor([student]);
      result.dates.forEach(function(date,index){
        var statusCell=document.createElement("td");
        statusCell.className="attendance-student-day";
        statusCell.dataset.dayIndex=String(index);
        var isNoClass=result.noClassDates.includes(date);
        var isStatusLocked=student.lockedDates.includes(date);
        statusCell.classList.toggle("attendance-no-class-cell",isNoClass);
        if(date===todayDate)statusCell.classList.add("attendance-today");
        var noClassMark=document.createElement("span");
        noClassMark.className="attendance-no-class-mark";
        noClassMark.dataset.dayIndex=String(index);
        noClassMark.textContent="NC";
        noClassMark.hidden=!isNoClass;
        var select=document.createElement("select");
        select.className="attendance-day-select";
        select.setAttribute("aria-label",student.name+", "+new Date(date+"T00:00:00").toLocaleDateString(undefined,{month:"long",day:"numeric"}));
        select.title="Blank: Present; CC or X: Absent; T: Tardy; E: Excused";
        select.dataset.studentId=student.id;
        select.dataset.dayIndex=String(index);
        select.disabled=isNoClass||isStatusLocked;
        select.hidden=isNoClass;
        result.statuses.filter(function(status){return ["Present","Absent","Tardy","Excused"].includes(status)}).forEach(function(status){
          var code=status==="Present"?"-":status==="Absent"?"CC":status==="Tardy"?"T":"E";
          select.add(new Option(code,status));
        });
        select.add(new Option("X","AbsentX"));
        select.value=student.attendance[index];
        var reasonInput=document.createElement("input");
        reasonInput.type="text";
        reasonInput.className="attendance-reason-input";
        reasonInput.placeholder=reasonPlaceholder(student.attendance[index]);
        reasonInput.maxLength=500;
        reasonInput.value=student.reasons[index]||"";
        reasonInput.dataset.studentId=student.id;
        reasonInput.dataset.dayIndex=String(index);
        reasonInput.setAttribute("aria-label","Optional reason for "+student.name+" on "+date);
        reasonInput.hidden=!hasReason(student.attendance[index])||isNoClass;
        reasonInput.required=false;
        reasonInput.disabled=isNoClass||isStatusLocked;
        reasonInput.addEventListener("input",function(){
          var studentRecord=attendanceData.students.find(function(entry){return entry.id===student.id});
          studentRecord.reasons[index]=reasonInput.value;
          attendanceDirty=true;
          $("attendanceNotice").textContent="";
          $("attendanceNotice").classList.remove("error");
        });
        select.addEventListener("change",function(){
          attendanceDirty=true;
          $("attendanceNotice").textContent="";
          $("attendanceNotice").classList.remove("error");
          var studentRecord=attendanceData.students.find(function(entry){return entry.id===student.id});
          var previousStatus=studentRecord.attendance[index];
          var previousTotalStatus=previousStatus==="AbsentX"?"Absent":previousStatus;
          if(Object.prototype.hasOwnProperty.call(studentTotals,previousTotalStatus))studentTotals[previousTotalStatus]-=1;
          var selectedStatus=select.value;
          var selectedTotalStatus=selectedStatus==="AbsentX"?"Absent":selectedStatus;
          studentRecord.attendance[index]=selectedStatus;
          if(!hasReason(selectedStatus))studentRecord.reasons[index]="";
          reasonInput.value=studentRecord.reasons[index]||"";
          reasonInput.hidden=!hasReason(selectedStatus)||isNoClass;
          reasonInput.required=false;
          reasonInput.placeholder=reasonPlaceholder(selectedStatus);
          if(hasReason(selectedStatus)&&!reasonInput.disabled)reasonInput.focus();
          if(Object.prototype.hasOwnProperty.call(studentTotals,selectedTotalStatus))studentTotals[selectedTotalStatus]+=1;
          statusKeys.forEach(function(status){
            row.querySelector('[data-total="'+status+'"]').textContent=String(studentTotals[status]);
          });
          refreshAllSummaryRows();
        });
        statusCell.append(noClassMark,select,reasonInput);
        row.appendChild(statusCell);
      });
      statusKeys.forEach(function(status){
        var totalCell=document.createElement("td");
        totalCell.className="attendance-total";
        totalCell.dataset.total=status;
        totalCell.textContent=String(studentTotals[status]);
        row.appendChild(totalCell);
      });
      var remarksCell=document.createElement("td");
      remarksCell.className="attendance-remarks";
      var remarksSelect=document.createElement("select");
      remarksSelect.className="attendance-remark-select";
      remarksSelect.setAttribute("aria-label","Monthly learner status for "+student.name);
      remarksSelect.add(new Option("No monthly status",""));
      remarksSelect.add(new Option("NLS - No longer in school","NLS"));
      remarksSelect.add(new Option("Transferred Out","Transferred Out"));
      remarksSelect.add(new Option("Transferred In","Transferred In"));
      remarksSelect.value=student.remarks||"";
      var statusDateInput=document.createElement("input");
      statusDateInput.className="attendance-status-date";
      statusDateInput.type="date";
      statusDateInput.dataset.studentId=student.id;
      statusDateInput.value=student.statusDate||"";
      statusDateInput.disabled=Boolean(student.statusInherited);
      statusDateInput.required=["NLS","Transferred Out","Transferred In"].includes(student.remarks);
      statusDateInput.min=result.month+"-01";
      statusDateInput.max=result.month+"-"+String(new Date(
        Number(result.month.slice(0,4)),
        Number(result.month.slice(5,7)),
        0
      ).getDate()).padStart(2,"0");
      statusDateInput.setAttribute("aria-label","Effective date for "+student.name+"'s monthly status");
      statusDateInput.addEventListener("change",function(){
        student.statusDate=statusDateInput.value;
        student.statusInherited=false;
        updateStatusLocks(student,row);
        attendanceDirty=true;
        $("attendanceNotice").textContent="";
        $("attendanceNotice").classList.remove("error");
      });
      remarksSelect.addEventListener("change",function(){
        if(!remarksSelect.value&&student.statusInherited){
          remarksSelect.value=student.remarks;
          return;
        }
        if(remarksSelect.value&&(
          remarksSelect.value!==student.remarks||student.statusInherited
        )){
          var today=new Date();
          var selectedMonth=result.month;
          var defaultDate=selectedMonth+"-01";
          if(selectedMonth===todayDate.slice(0,7))defaultDate=todayDate;
          student.statusDate=defaultDate;
          statusDateInput.value=defaultDate;
          statusDateInput.disabled=false;
          student.statusInherited=false;
        }else if(!remarksSelect.value){
          student.statusDate="";
          statusDateInput.value="";
          statusDateInput.disabled=false;
        }
        student.remarks=remarksSelect.value;
        statusDateInput.required=Boolean(student.remarks);
        updateStatusLocks(student,row);
        attendanceDirty=true;
        $("attendanceNotice").textContent="";
        $("attendanceNotice").classList.remove("error");
      });
      remarksCell.appendChild(remarksSelect);
      remarksCell.appendChild(statusDateInput);
      row.appendChild(remarksCell);
      $("attendanceRows").appendChild(row);
      });
      appendSummaryRow($("attendanceRows"),group.name,group.students,"attendance-month-total");
    });
    appendSummaryRow($("attendanceTotals"),"COMBINED",rosterStudents,"attendance-daily-totals");
    paintAttendanceSelects();
    filterAttendanceRows();
    window.requestAnimationFrame(positionAttendanceHeader);
    if(result.month===todayDate.slice(0,7)){
      window.requestAnimationFrame(function(){
        var targetDate=todayIndex>=0?todayDate:result.dates.find(function(date){return date>todayDate})||result.dates[result.dates.length-1];
        var targetHeader=$("attendanceHead").querySelector('[data-attendance-date="'+targetDate+'"]');
        var tableWrap=$("attendanceTable").closest(".table-wrap");
        if(!targetHeader||!tableWrap)return;
        var headerRect=targetHeader.getBoundingClientRect();
        var wrapRect=tableWrap.getBoundingClientRect();
        tableWrap.scrollLeft+=headerRect.left-wrapRect.left-(tableWrap.clientWidth-headerRect.width)/2;
      });
    }
  }

  var appDragScrollState=null;
  var suppressDragClick=false;

  function scrollableAncestor(target,axis){
    var element=target instanceof Element?target:target.parentElement;
    while(element){
      var maximum=axis==="x"
        ?element.scrollWidth-element.clientWidth
        :element.scrollHeight-element.clientHeight;
      var overflow=axis==="x"
        ?window.getComputedStyle(element).overflowX
        :window.getComputedStyle(element).overflowY;
      if(maximum>1&&(overflow==="auto"||overflow==="scroll"||element===document.scrollingElement))return element;
      element=element.parentElement;
    }
    return null;
  }

  document.addEventListener("pointerdown",function(event){
    if(event.pointerType!=="mouse"||!event.isPrimary||event.button!==0)return;
    if(event.target.closest("input,select,textarea,option,[contenteditable='true'],[role='slider']"))return;
    if(window.getSelection()&&window.getSelection().toString())return;
    var target=event.target instanceof Element?event.target:event.target.parentElement;
    var horizontal=scrollableAncestor(target,"x");
    var vertical=scrollableAncestor(target,"y");
    if(!horizontal&&!vertical)return;
    appDragScrollState={
      pointerId:event.pointerId,
      startX:event.clientX,
      startY:event.clientY,
      horizontal:horizontal,
      vertical:vertical,
      startScrollLeft:horizontal?horizontal.scrollLeft:0,
      startScrollTop:vertical?vertical.scrollTop:0,
      dragging:false
    };
  });

  document.addEventListener("pointermove",function(event){
    var state=appDragScrollState;
    if(!state||event.pointerId!==state.pointerId)return;
    var distanceX=event.clientX-state.startX;
    var distanceY=event.clientY-state.startY;
    var canScrollX=state.horizontal&&Math.abs(distanceX)>1;
    var canScrollY=state.vertical&&Math.abs(distanceY)>1;
    if(!state.dragging&&Math.max(canScrollX?Math.abs(distanceX):0,canScrollY?Math.abs(distanceY):0)<5)return;
    if(!state.dragging){
      state.dragging=true;
      document.body.classList.add("is-drag-scrolling");
      if(state.horizontal)state.horizontal.classList.add("is-drag-scrolling","is-dragging");
      if(state.vertical)state.vertical.classList.add("is-drag-scrolling","is-dragging");
      if(window.getSelection())window.getSelection().removeAllRanges();
    }
    if(state.horizontal)state.horizontal.scrollLeft=state.startScrollLeft-distanceX;
    if(state.vertical)state.vertical.scrollTop=state.startScrollTop-distanceY;
    event.preventDefault();
  });

  function finishAppDragScroll(event){
    var state=appDragScrollState;
    if(!state)return;
    if(event&&typeof event.pointerId==="number"&&event.pointerId!==state.pointerId)return;
    if(state.dragging){
      suppressDragClick=true;
      window.setTimeout(function(){suppressDragClick=false},0);
    }
    document.body.classList.remove("is-drag-scrolling");
    if(state.horizontal)state.horizontal.classList.remove("is-drag-scrolling","is-dragging");
    if(state.vertical)state.vertical.classList.remove("is-drag-scrolling","is-dragging");
    appDragScrollState=null;
  }

  document.addEventListener("pointerup",finishAppDragScroll);
  document.addEventListener("pointercancel",finishAppDragScroll);
  window.addEventListener("blur",function(){
    if(!appDragScrollState)return;
    finishAppDragScroll({pointerId:appDragScrollState.pointerId});
  });
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="hidden"&&appDragScrollState)finishAppDragScroll();
  });
  window.addEventListener("focus",function(){
    if(document.body.classList.contains("is-drag-scrolling"))finishAppDragScroll();
  });
  document.addEventListener("click",function(event){
    if(!suppressDragClick)return;
    suppressDragClick=false;
    event.preventDefault();
    event.stopImmediatePropagation();
  },true);

  function countClassDays(result){
    var noClassDates=new Set(Array.isArray(result.noClassDates)?result.noClassDates:[]);
    var dates=Array.isArray(result.dates)?result.dates:[];
    return dates.filter(function(date){
      var weekday=new Date(date+"T00:00:00").getDay();
      return weekday!==0&&weekday!==6&&!noClassDates.has(date);
    }).length;
  }

  function selectedAttendanceMonth(){
    return $("attendanceYear").value+"-"+String($("attendanceMonth").value).padStart(2,"0");
  }

  function attendanceSchoolYearRange(){
    var startDate=$("teacherProfileFirstDayOfSchool").value;
    var endDate=$("teacherProfileEndOfSchoolYear").value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ||startDate>endDate)return null;
    return{startDate:startDate,endDate:endDate};
  }

  function isAttendanceMonthAllowed(month,range){
    return Boolean(range)&&month>=range.startDate.slice(0,7)&&month<=range.endDate.slice(0,7);
  }

  function isDefaultPresentDate(result,date,student){
    var weekday=new Date(date+"T00:00:00").getDay();
    var now=new Date();
    var today=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0");
    return weekday!==0&&weekday!==6&&date<=today
      &&!(result.noClassDates||[]).includes(date)
      &&!((student&&student.lockedDates)||[]).includes(date);
  }

  function applyDefaultPresent(result){
    var changed=false;
    result.students.forEach(function(student){
      if(!Array.isArray(student.attendance))return;
      result.dates.forEach(function(date,index){
        if(student.attendance[index]===""&&isDefaultPresentDate(result,date,student)){
          student.attendance[index]="Present";
          changed=true;
        }
      });
    });
    return changed;
  }

  async function loadAttendance(){
    var month=selectedAttendanceMonth();
    var requestId=++attendanceRequestId;
    $("attendanceNotice").textContent="";
    $("attendanceNotice").classList.remove("error");
    $("attendanceCount").textContent="Loading students...";
    $("attendanceSavedDays").textContent="—";
    $("attendanceRows").replaceChildren();
    $("attendanceHead").replaceChildren();
    $("attendanceTotals").replaceChildren();
    $("saveAttendance").disabled=true;
    $("clearAttendanceMonth").disabled=true;
    var schoolYear=attendanceSchoolYearRange();
    if(!schoolYear){
      attendanceData=null;
      activeAttendanceMonth="";
      $("attendanceCount").textContent="Dates required";
      $("attendanceSavedDays").textContent="—";
      $("attendanceNotice").textContent="Set valid First day of school and End of school year dates in Teacher Profile before recording attendance.";
      $("attendanceNotice").classList.add("error");
      $("attendanceTable").hidden=true;
      $("attendanceEmpty").hidden=true;
      renderNoClassSummary({noClassDates:[],noClassReasons:{}});
      $("importSF2").disabled=true;
      $("downloadSF2").disabled=true;
      return;
    }
    if(!isAttendanceMonthAllowed(month,schoolYear)){
      refreshAttendanceYears();
      month=selectedAttendanceMonth();
    }
    $("importSF2").disabled=false;
    $("downloadSF2").disabled=false;
    try{
      var result=await api("/api/attendance/month?month="+encodeURIComponent(month));
      if(requestId!==attendanceRequestId||month!==selectedAttendanceMonth())return;
      if(result.month!==month)throw new Error("The server returned attendance for a different month.");
      attendanceData=result;
      activeAttendanceMonth=month;
      var autoMarked=applyDefaultPresent(result);
      attendanceDirty=autoMarked;
      if(autoMarked){
        $("attendanceNotice").textContent="Unmarked class days are set to Present (-). Change only learners who were absent, tardy or excused, then click Save Attendance.";
      }
      var visibleStudents=filterStudentsForActiveSection(result.students);
      renderAttendance(Object.assign({},result,{students:visibleStudents}));
      $("saveAttendance").disabled=visibleStudents.filter(function(student){return student && student.id && String(student.name||"").trim();}).length===0;
    }catch(error){
      if(requestId!==attendanceRequestId)return;
      $("attendanceCount").textContent="Unable to load";
      $("attendanceSavedDays").textContent="Unable to load";
      $("attendanceNotice").textContent=error.message;
      $("attendanceNotice").classList.add("error");
      $("saveAttendance").disabled=true;
      $("clearAttendanceMonth").disabled=true;
    }
  }

  var attendanceSummaryData=null;
  var attendanceSummarySheet="all";

  function attendancePercent(present,absent){
    var total=present+absent;
    return total?(present/total*100).toFixed(1)+"%":"—";
  }

  function renderAttendanceSummarySheet(){
    var result=attendanceSummaryData;
    var head=$("attendanceSummaryHead");
    var rows=$("attendanceSummaryRows");
    var foot=$("attendanceSummaryFoot");
    head.replaceChildren();
    rows.replaceChildren();
    foot.replaceChildren();
    if(!result)return;
    var isAll=attendanceSummarySheet==="all";
    function monthLabel(month){
      return new Date(month+"-01T00:00:00.000Z").toLocaleDateString(undefined,{month:"long",year:"numeric",timeZone:"UTC"});
    }
    function cell(tag,text,className){
      var element=document.createElement(tag);
      element.textContent=text;
      if(className)element.className=className;
      return element;
    }
    var columns=isAll
      ?result.months.map(function(month){return{key:month,label:new Date(month+"-01T00:00:00.000Z").toLocaleDateString(undefined,{month:"short",timeZone:"UTC"})}})
      :[];
    var headerRow=document.createElement("tr");
    var detailRow=document.createElement("tr");
    headerRow.className="attendance-summary-head-group";
    detailRow.className="attendance-summary-head-columns";
    var numberHeader=cell("th","#","attendance-summary-corner");
    var learnerHeader=cell("th","Learner","attendance-summary-corner");
    numberHeader.rowSpan=2;
    learnerHeader.rowSpan=2;
    headerRow.append(numberHeader,learnerHeader);
    columns.forEach(function(column){
      var top=cell("th",column.label,"attendance-summary-month");
      top.colSpan=2;
      top.title=monthLabel(column.key);
      headerRow.appendChild(top);
      detailRow.append(
        cell("th","Present","attendance-summary-month-detail"),
        cell("th","Absent","attendance-summary-month-detail")
      );
    });
    var totalHeading=cell("th",isAll?"School-year total":monthLabel(attendanceSummarySheet),"attendance-summary-key attendance-summary-group-total");
    totalHeading.colSpan=4;
    headerRow.appendChild(totalHeading);
    detailRow.append(
      cell("th","Present","attendance-summary-key"),
      cell("th","Absent","attendance-summary-key"),
      cell("th","Days","attendance-summary-key"),
      cell("th","Attendance %","attendance-summary-key")
    );
    head.append(headerRow,detailRow);

    function figures(student){
      if(isAll)return{present:student.present,absent:student.absent};
      var monthly=student.months&&student.months[attendanceSummarySheet]||{present:0,absent:0};
      return{present:monthly.present,absent:monthly.absent};
    }
    var sums={present:0,absent:0,perMonth:{}};
    result.students.forEach(function(student,index){
      var row=document.createElement("tr");
      row.appendChild(cell("td",String(index+1),"attendance-summary-rownum"));
      var name=cell("td",student.name);
      name.title=student.name;
      row.appendChild(name);
      columns.forEach(function(column){
        var monthly=student.months&&student.months[column.key]||{present:0,absent:0};
        var entry=sums.perMonth[column.key]||(sums.perMonth[column.key]={present:0,absent:0});
        entry.present+=monthly.present;
        entry.absent+=monthly.absent;
        row.append(
          cell("td",String(monthly.present),"attendance-summary-month-value attendance-summary-month-present"),
          cell("td",String(monthly.absent),"attendance-summary-month-value"+(monthly.absent?" attendance-summary-has-absence":""))
        );
      });
      var value=figures(student);
      sums.present+=value.present;
      sums.absent+=value.absent;
      row.append(
        cell("td",String(value.present),"attendance-summary-total"),
        cell("td",String(value.absent),"attendance-summary-total"+(value.absent?" attendance-summary-has-absence":"")),
        cell("td",String(value.present+value.absent),"attendance-summary-total"),
        cell("td",attendancePercent(value.present,value.absent),"attendance-summary-total attendance-summary-percent")
      );
      rows.appendChild(row);
    });
    if(result.students.length){
      var totalRow=document.createElement("tr");
      var label=cell("th","CLASS TOTAL","attendance-summary-footlabel");
      label.colSpan=2;
      totalRow.appendChild(label);
      columns.forEach(function(column){
        var entry=sums.perMonth[column.key]||{present:0,absent:0};
        totalRow.append(
          cell("td",String(entry.present),"attendance-summary-month-total"),
          cell("td",String(entry.absent),"attendance-summary-month-total")
        );
      });
      totalRow.append(
        cell("td",String(sums.present)),
        cell("td",String(sums.absent)),
        cell("td",String(sums.present+sums.absent)),
        cell("td",attendancePercent(sums.present,sums.absent))
      );
      foot.appendChild(totalRow);
    }
    $("attendanceSummaryEmpty").hidden=result.students.length>0;
    $("attendanceSheetName").textContent=isAll?"Full School Year":monthLabel(attendanceSummarySheet);
    $("attendanceSheetNote").textContent="Present includes tardy days. Excused, unmarked, no-class and locked days are excluded.";

    var tabs=$("attendanceSheetTabs");
    tabs.replaceChildren();
    [{key:"all",label:"Full School Year"}].concat(result.months.map(function(month){
      return{key:month,label:new Date(month+"-01T00:00:00.000Z").toLocaleDateString(undefined,{month:"short",year:"numeric",timeZone:"UTC"})};
    })).forEach(function(sheet){
      var tab=document.createElement("button");
      tab.type="button";
      tab.className="attendance-sheet-tab";
      tab.setAttribute("role","tab");
      tab.setAttribute("aria-selected",String(sheet.key===attendanceSummarySheet));
      tab.textContent=sheet.label;
      tab.addEventListener("click",function(){
        attendanceSummarySheet=sheet.key;
        renderAttendanceSummarySheet();
      });
      tabs.appendChild(tab);
    });
  }

  async function loadAttendanceSummary(){
    var requestId=++attendanceSummaryRequestId;
    var rows=$("attendanceSummaryRows");
    var head=$("attendanceSummaryHead");
    rows.replaceChildren();
    head.replaceChildren();
    $("attendanceSummaryNotice").textContent="";
    $("attendanceSummaryNotice").classList.remove("error");
    $("attendanceSummaryRange").textContent="Loading saved attendance totals...";
    $("refreshAttendanceSummary").disabled=true;
    try{
      var result=await api("/api/attendance/summary");
      if(requestId!==attendanceSummaryRequestId)return;
      if(!Array.isArray(result.students)||!Array.isArray(result.months)||!result.firstDayOfSchool||!result.endOfSchoolYear)throw new Error("The server returned an invalid attendance summary.");
      result.students=filterStudentsForActiveSection(result.students);
      attendanceSummaryData=result;
      if(attendanceSummarySheet!=="all"&&!result.months.includes(attendanceSummarySheet))attendanceSummarySheet="all";
      renderAttendanceSummarySheet();
      function dateLabel(date){
        return new Date(date+"T00:00:00.000Z").toLocaleDateString(undefined,{month:"long",day:"numeric",year:"numeric",timeZone:"UTC"});
      }
      var range="School year: "+dateLabel(result.firstDayOfSchool)+" to "+dateLabel(result.endOfSchoolYear)+".";
      $("attendanceSummaryRange").textContent=range+(result.firstDate&&result.lastDate
        ?" Saved records: "+dateLabel(result.firstDate)+" to "+dateLabel(result.lastDate)+"."
        :" No saved attendance records yet.");
    }catch(error){
      if(requestId!==attendanceSummaryRequestId)return;
      $("attendanceSummaryRange").textContent="Unable to load attendance totals.";
      $("attendanceSummaryNotice").textContent=error.message;
      $("attendanceSummaryNotice").classList.add("error");
    }finally{
      if(requestId===attendanceSummaryRequestId)$("refreshAttendanceSummary").disabled=false;
    }
  }

  function setAttendanceTab(summarySelected){
    if(attendanceDirty&&!window.confirm("Discard unsaved attendance changes?")){
      return;
    }
    if(attendanceDirty){
      attendanceDirty=false;
      if(activeAttendanceMonth){
        $("attendanceMonth").value=String(Number(activeAttendanceMonth.slice(5,7)));
        $("attendanceYear").value=activeAttendanceMonth.slice(0,4);
      }
    }
    $("attendanceMonthlyTab").setAttribute("aria-selected",String(!summarySelected));
    $("attendanceSummaryTab").setAttribute("aria-selected",String(summarySelected));
    $("attendanceMonthlyPanel").hidden=summarySelected;
    $("attendanceSummaryPanel").hidden=!summarySelected;
    if(summarySelected)loadAttendanceSummary();
    else loadAttendance();
  }

  function getGradeInterpretation(grade){
    if(typeof grade!=="number"||!Number.isFinite(grade)||grade<0||grade>100)return null;
    if(grade>=90)return{label:"Advancing",range:"90–100",description:"Exceeds expectations."};
    if(grade>=85)return{label:"Benchmarking",range:"85–89",description:"Meets expectations."};
    if(grade>=80)return{label:"Connecting",range:"80–84",description:"Approaching expectations."};
    if(grade>=75)return{label:"Developing",range:"75–79",description:"Beginning to meet expectations."};
    return{label:"Emerging",range:"Below 75",description:"Needs significant support to meet expectations."};
  }

  function createGradeInterpretationNote(){
    var note=document.createElement("div");
    note.className="grade-interpretation";
    var list=document.createElement("ul");
    [
      ["Advancing","90–100","Exceeds expectations."],
      ["Benchmarking","85–89","Meets expectations."],
      ["Connecting","80–84","Approaching expectations."],
      ["Developing","75–79","Beginning to meet expectations."],
      ["Emerging","Below 75","Needs significant support to meet expectations."]
    ].forEach(function(item){
      var entry=document.createElement("li");
      entry.textContent=item[0]+" ("+item[1]+") — "+item[2];
      list.append(entry);
    });
    var sources=document.createElement("p");
    sources.className="grade-interpretation-sources";
    sources.append("References: ");
    [
      ["toolism.app","https://toolism.app/blog/deped-grading-system-2026"],
      ["DepEd Order No. 015, s. 2026","https://deped.gov.ph/do-015-s-2026-revised-guidelines-on-classroom-assessment-grading-system-and-awards-and-recognition-for-the-k-to-12-basic-education-program/"]
    ].forEach(function(source,index){
      if(index)sources.append(" · ");
      var link=document.createElement("a");
      link.href=source[1];
      link.target="_blank";
      link.rel="noopener noreferrer";
      link.textContent=source[0];
      sources.append(link);
    });
    note.append(list,sources);
    return note;
  }

  $("gradeInterpretation").append(createGradeInterpretationNote());
  $("gradeSummaryInterpretation").append(createGradeInterpretationNote());

  function updateMapehAverage(){
    var music=$("gradeMusicAndArts").value;
    var physicalEducation=$("gradePhysicalEducationAndHealth").value;
    var mapeh=music!==""&&physicalEducation!==""
      ?(Number(music)+Number(physicalEducation))/2
      :null;
    $("gradeMapeh").textContent=mapeh===null?"—":mapeh.toFixed(2);
    var descriptor=$("gradeGeneralAverageDescriptor");
    descriptor.hidden=true;
    descriptor.textContent="";
    var hasMapeh=gradeFields.some(function(field){return field[0]==="musicAndArts"})
      &&gradeFields.some(function(field){return field[0]==="physicalEducationAndHealth"});
    var averageKeys=gradeFields.map(function(field){return field[0]})
      .filter(function(key){return !hasMapeh||!["musicAndArts","physicalEducationAndHealth"].includes(key)});
    if(hasMapeh)averageKeys.push("mapeh");
    var generalGrades=averageKeys.map(function(key){
      return key==="mapeh"?mapeh:$("grade"+key[0].toUpperCase()+key.slice(1)).value;
    });
    if((hasMapeh&&mapeh===null)||!generalGrades.length||generalGrades.some(function(grade){return grade===""})){
      $("gradeGeneralAverage").textContent="—";
      return;
    }
    var total=generalGrades.reduce(function(sum,grade){return sum+Number(grade)},0);
    var generalAverage=Number((total/generalGrades.length).toFixed(2));
    $("gradeGeneralAverage").textContent=generalAverage.toFixed(2);
    var interpretation=getGradeInterpretation(generalAverage);
    if(interpretation){
      descriptor.textContent=interpretation.label+" ("+interpretation.range+") — "+interpretation.description;
      descriptor.hidden=false;
    }
  }

  function clearGradeInputs(){
    gradeFields.forEach(function(field){
      $("grade"+field[0][0].toUpperCase()+field[0].slice(1)).value="";
    });
    $("gradeTeacherComment").value="";
    $("gradeCommentSuggestion").value="";
    $("addGradeCommentSuggestion").disabled=true;
    $("gradeCommentSuggestionStatus").textContent="";
    $("gradeCommentSuggestionStatus").classList.remove("error");
    updateTeacherCommentCount();
    updateMapehAverage();
  }

  function updateGradeEditorState(){
    var disabled=activeTermLocked||gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value;
    $("gradeTerm").disabled=gradeEditUpdating||gradeSaving;
    $("gradeStudent").disabled=gradeEditUpdating||gradeSaving||gradeStudents.length===0;
    $("gradeFields").disabled=disabled||gradeSaving;
    gradeFields.forEach(function(field){
      var inputId="grade"+field[0][0].toUpperCase()+field[0].slice(1);
      var fromEClass=activeEClassGradeSubjects.has(field[0]);
      $(inputId).disabled=disabled||fromEClass;
      var label=document.querySelector('label[for="'+inputId+'"]');
      if(label)label.textContent=field[1]+(fromEClass?" (E-Class — read-only)":"");
    });
    $("saveGrades").disabled=disabled||gradeSaving;
    $("saveGrades").hidden=activeTermLocked;
    $("printSF9").disabled=gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value||gradeSaving||gradesDirty;
    var reportUnavailable=gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value||gradeSaving||gradesDirty;
    $("downloadSF9").disabled=reportUnavailable||$("downloadSF9").getAttribute("aria-busy")==="true";
    $("editGrades").hidden=gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value;
    $("editGrades").textContent=activeTermLocked?"Unlock Term with password":"Lock Term";
    $("editGrades").disabled=gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value||gradeEditUpdating||gradeSaving;
  }

  function updateTeacherCommentCount(){
    var comment=$("gradeTeacherComment").value;
    $("gradeTeacherCommentCount").textContent=comment.length.toLocaleString()+" / 1,000";
  }

  function selectedGradeStudentName(){
    var studentSelect=$("gradeStudent");
    return studentSelect.selectedIndex>=0
      ?studentSelect.options[studentSelect.selectedIndex].textContent
      :"selected student";
  }

  function updateGradeLockDisplay(locked){
    activeTermLocked=locked;
    var status=$("gradeLockStatus");
    $("gradeLockControl").dataset.locked=String(locked);
    $("gradeLockBadge").textContent=locked?"LOCKED":"UNLOCKED";
    status.textContent=locked
      ?$("gradeTerm").value+" grades are locked for all students. Password required to unlock direct edits."
      :$("gradeTerm").value+" grades are unlocked for all students.";
    status.dataset.locked=String(locked);
    $("gradeFields").disabled=locked||gradeRecordLoading||!gradeRecordAvailable||!$("gradeStudent").value||gradeSaving;
    updateGradeEditorState();
  }

  async function loadGradeRecord(){
    var studentId=$("gradeStudent").value;
    var term=$("gradeTerm").value;
    var requestId=++gradeLoadRequestId;
    $("gradeNotice").textContent="";
    $("gradeNotice").classList.remove("error");
    clearGradeInputs();
    activeEClassGradeSubjects.clear();
    gradesDirty=false;
    activeGradeSelection={studentId:studentId,term:term};
    gradeRecordAvailable=false;
    gradeRecordLoading=true;
    $("gradeLockStatus").textContent="Checking grade lock...";
    $("gradeLockStatus").dataset.locked="";
    $("gradeLockControl").dataset.locked="";
    $("gradeLockBadge").textContent="CHECKING";
    updateGradeEditorState();
    if(!studentId){
      $("gradeNotice").textContent="Add or import students before entering grades.";
    }
    try{
      var requests=studentId?[
        api("/api/grades/term-lock?term="+encodeURIComponent(term)),
        api("/api/grades?studentId="+encodeURIComponent(studentId)+"&term="+encodeURIComponent(term))
      ]:[Promise.resolve({locked:false}),Promise.resolve(null)];
      var results=await Promise.all(requests);
      if(requestId!==gradeLoadRequestId)return;
      updateGradeLockDisplay(results[0].locked);
      if(results[1]){
        activeEClassGradeSubjects=new Set(Array.isArray(results[1].eClassSubjects)
          ?results[1].eClassSubjects
          :[]);
        gradeFields.forEach(function(field){
          $("grade"+field[0][0].toUpperCase()+field[0].slice(1)).value=results[1].grades[field[0]];
        });
        $("gradeTeacherComment").value=results[1].teacherComment||"";
        updateTeacherCommentCount();
        updateMapehAverage();
      }else{
        activeEClassGradeSubjects.clear();
      }
      gradeRecordAvailable=true;
    }catch(error){
      if(requestId===gradeLoadRequestId){
        $("gradeLockStatus").textContent="Unable to verify grade lock.";
        $("gradeLockStatus").dataset.locked="";
        $("gradeLockControl").dataset.locked="";
        $("gradeLockBadge").textContent="UNVERIFIED";
        $("gradeNotice").textContent=error.message;
        $("gradeNotice").classList.add("error");
      }
    }finally{
      if(requestId===gradeLoadRequestId){
        gradeRecordLoading=false;
        updateGradeEditorState();
      }
    }
  }

  async function loadGradeStudents(){
    $("gradeNotice").textContent="";
    $("gradeNotice").classList.remove("error");
    $("gradeStudent").disabled=true;
    $("gradeStudent").replaceChildren(new Option("Loading students...",""));
    try{
      var result=await api("/api/students");
      gradeStudents=filterStudentsForActiveSection(result.students);
      $("gradeStudent").replaceChildren();
      if(!gradeStudents.length){
        $("gradeStudent").add(new Option("No students in roster",""));
        await loadGradeRecord();
        return;
      }
      gradeStudents.forEach(function(student){
        var label=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
        $("gradeStudent").add(new Option(label+" — "+student.lrn,student.id));
      });
      var hasPrevious=gradeStudents.some(function(student){return student.id===activeGradeSelection.studentId});
      $("gradeStudent").value=hasPrevious?activeGradeSelection.studentId:gradeStudents[0].id;
      $("gradeTerm").value=activeGradeSelection.term;
      await loadGradeRecord();
    }catch(error){
      $("gradeStudent").replaceChildren(new Option("Unable to load students",""));
      $("gradeNotice").textContent=error.message;
      $("gradeNotice").classList.add("error");
    }finally{
      $("gradeStudent").disabled=gradeStudents.length===0;
    }
  }

  var eClassTransmutationRanges=[
    [99.50,100.00,100],[98.32,99.49,99],[97.14,98.31,98],[95.96,97.13,97],
    [94.78,95.95,96],[93.60,94.77,95],[92.42,93.59,94],[91.24,92.41,93],
    [90.06,91.23,92],[88.88,90.05,91],[87.70,88.87,90],[86.52,87.69,89],
    [85.34,86.51,88],[84.16,85.33,87],[82.98,84.15,86],[81.80,82.97,85],
    [80.62,81.79,84],[79.44,80.61,83],[78.26,79.43,82],[77.08,78.25,81],
    [75.90,77.07,80],[74.72,75.89,79],[73.54,74.71,78],[72.36,73.53,77],
    [71.18,72.35,76],[70.00,71.17,75],[65.34,69.99,74],[60.67,65.33,73],
    [56.01,60.66,72],[51.34,56.00,71],[46.67,51.33,70],[42.01,46.66,69],
    [37.34,42.00,68],[32.68,37.33,67],[28.01,32.67,66],[23.35,28.00,65],
    [18.68,23.34,64],[14.01,18.67,63],[9.35,14.00,62],[4.68,9.34,61],
    [0.00,4.67,60]
  ];

  function eClassGradeForInitial(initialGrade,method){
    if(!Number.isFinite(initialGrade))return {termGrade:"",descriptor:""};
    var descriptorFor=function(value){
      return value>=90?"Advancing":value>=80?"Benchmarking"
        :value>=75?"Connecting":value>=65?"Developing":"Emerging";
    };
    if(method==="descriptive")return {termGrade:"",descriptor:descriptorFor(Math.round(initialGrade+1e-9))};
    if(method==="zero-based"){
      var zeroBased=Math.max(60,Math.round(initialGrade+1e-9));
      return {termGrade:String(zeroBased),descriptor:descriptorFor(zeroBased)};
    }
    var roundedInitial=Math.round((initialGrade+1e-9)*100);
    var range=eClassTransmutationRanges.find(function(entry){
      return roundedInitial>=Math.round(entry[0]*100)&&roundedInitial<=Math.round(entry[1]*100);
    });
    if(!range)return {termGrade:"",descriptor:""};
    var termGrade=range[2];
    return {termGrade:String(termGrade),descriptor:descriptorFor(termGrade)};
  }

  function eClassScoreValidationMessage(value,maximumValue){
    var scoreText=String(value??"").trim();
    if(!scoreText)return "";
    var score=Number(scoreText);
    if(!Number.isFinite(score)||score<0)return "Enter a valid non-negative score.";
    var maximum=Number(maximumValue);
    if(!Number.isFinite(maximum)||maximum<=0){
      return "Enter a positive highest possible score before recording this score.";
    }
    if(score>maximum)return "Score cannot exceed the highest possible score of "+maximum+".";
    return "";
  }

  function parseHighestScoreValues(serialized){
    var parsed=JSON.parse(serialized);
    if(!Array.isArray(parsed)||parsed.some(function(score){return typeof score!=="string"})){
      throw new Error("Saved highest-possible-score data is invalid.");
    }
    if(parsed.length===11)return parsed;
    if(parsed.length===22){
      return [parsed[0],parsed[1],parsed[2],parsed[3],parsed[4],parsed[8],parsed[9],parsed[10],
        parsed[14],parsed[15],parsed[16]];
    }
    throw new Error("Saved highest-possible-score data has an unexpected number of values.");
  }

  async function renderEClassTable(){
    var eClassNotice=$("eClassNotice");
    var eClassStudentCount=$("eClassStudentCount");
    var downloadButton=$("downloadEClass");
    var saveButton=$("saveEClassRecord");
    var unlockButton=$("unlockEClassRecord");
    var importButton=$("importEClass");
    var importFile=$("eClassImportFile");
    var lockStatus=$("eClassLockStatus");
    var selectedTerm=$("eClassTerm").value;
    var selectedSubject=$("eClassSubject").value;
    var isMapeh=selectedSubject==="MAPEH";
    var selectedMapehGroup=$("eClassMapehGroup").value;
    var selectedSection=activeStudentSection;
    var recordLocked=false;
    var recordLoading=true;
    var recordSaving=false;
    var recordSaved=false;
    var recordTable=null;
    eClassDirty=false;
    downloadButton.disabled=true;
    saveButton.disabled=true;
    unlockButton.disabled=true;
    unlockButton.hidden=true;
    lockStatus.dataset.locked="";
    lockStatus.textContent="Checking E-Class record lock...";
    function updateRecordLockState(locked){
      recordLocked=locked;
      recordLoading=false;
      saveButton.disabled=recordSaving||recordLocked||!recordTable;
      importButton.disabled=recordSaving||recordLocked||recordLoading||!recordTable;
      unlockButton.hidden=!recordLocked;
      unlockButton.disabled=recordSaving||recordLoading;
      lockStatus.dataset.locked=String(recordLocked);
      lockStatus.textContent=recordLocked
        ?selectedTerm+" · "+selectedSubject+(isMapeh?" · "+selectedMapehGroup:"")+" is saved and locked. Unlock with your password to make changes."
        :recordSaved
        ?selectedTerm+" · "+selectedSubject+" is unlocked for editing. Save & Lock Record when finished."
        :"No saved E-Class record yet. Save & Lock Record to store and lock this record.";
      if(!recordTable)return;
      recordTable.querySelectorAll("input[data-score-index]").forEach(function(input){
        input.disabled=recordLocked||Boolean(input.closest("tr")&&input.closest("tr").dataset.inactive);
      });
      recordTable.querySelectorAll("th[data-highest-possible-score]").forEach(function(cell){
        if(recordLocked){
          cell.removeAttribute("contenteditable");
          cell.tabIndex=-1;
        }else{
          cell.setAttribute("contenteditable","plaintext-only");
          cell.tabIndex=0;
        }
      });
    }
    importButton.onclick=function(){
      if(!recordLocked&&!recordLoading)importFile.click();
    };
    importFile.onchange=async function(){
      var file=this.files&&this.files[0];
      this.value="";
      if(!file||recordLocked||recordLoading)return;
      importButton.disabled=true;
      importButton.setAttribute("aria-busy","true");
      try{
        var response=await fetch("/api/e-class/import?term="+encodeURIComponent(selectedTerm)
          +"&subject="+encodeURIComponent(selectedSubject)
          +"&mapehGroup="+encodeURIComponent(selectedMapehGroup),{
            method:"POST",
            headers:{"Content-Type":"application/octet-stream"},
            body:file
          });
        var result=response.ok?await response.json():await response.json().then(function(error){throw new Error(error.error||"Unable to import the E-Class workbook.")});
        var normalizeName=function(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"")};
        if(selectedSection&&selectedSection!=="__all__"&&selectedSection!=="__unassigned__"&&result.section
          &&normalizeName(result.section)!==normalizeName(selectedSection)){
          throw new Error("The workbook is for section "+result.section+", but the selected section is "+selectedSection+".");
        }
        var rowsByName=Object.create(null);
        result.students.forEach(function(entry){
          var key=normalizeName(entry.name);
          if(!key||rowsByName[key])throw new Error("The workbook contains duplicate or blank learner names.");
          rowsByName[key]=entry;
        });
        var table=$("eClassTableWrap").querySelector("table");
        var rosterRows=Array.from(table.querySelectorAll("tbody tr[data-student-id]"));
        var unmatched=Object.keys(rowsByName).filter(function(key){
          return !rosterRows.some(function(row){return normalizeName(row.dataset.studentName)===key});
        }).map(function(key){return rowsByName[key].name});
        var skippedNames=unmatched;
        unmatched.forEach(function(){});
        if(!rosterRows.length)throw new Error("There are no learners in the displayed roster to import into.");
        if(Array.isArray(result.highestScores)){
          var maximumCells=Array.from(table.tHead.rows[2].cells).filter(function(cell){
            return cell.hasAttribute("data-highest-possible-score");
          });
          result.highestScores.forEach(function(value,index){
            if(maximumCells[index]){
              maximumCells[index].textContent=value;
              maximumCells[index].dispatchEvent(new Event("input",{bubbles:true}));
            }
          });
        }
        var imported=0;
        rosterRows.forEach(function(row){
          var entry=rowsByName[normalizeName(row.dataset.studentName)];
          if(!entry||row.dataset.inactive)return;
          row.querySelectorAll("input[data-score-index]").forEach(function(input,index){
            input.value=entry.scores[index]||"";
            input.dispatchEvent(new Event("input",{bubbles:true}));
          });
          imported++;
        });
        eClassNotice.classList.remove("error");
        eClassNotice.textContent="Imported "+imported+" learner record"+(imported===1?"":"s")+" ("+selectedTerm+" · "+selectedSubject+(result.grade?" · Grade "+result.grade:"")+(result.section?" · "+result.section:"")+") from "+file.name+". Review the inputs, then select Save & Lock Record.";
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not import the E-Class workbook: "+error.message;
      }finally{
        importButton.disabled=recordLocked||recordLoading||!recordTable;
        importButton.removeAttribute("aria-busy");
      }
    };
    downloadButton.onclick=async function(){
      downloadButton.disabled=true;
      downloadButton.setAttribute("aria-busy","true");
      try{
        var table=$("eClassTableWrap").querySelector("table");
        if(!table)throw new Error("The E-Class record is not ready to download.");
        var students=Array.from(table.querySelectorAll("tbody tr[data-student-id]")).map(function(row){
          return {
            id:row.dataset.studentId,
            values:Array.from(row.cells).slice(2).map(function(cell){
              var control=cell.querySelector("input,textarea,select");
              return control?control.value:cell.textContent.trim();
            })
          };
        });
        if(!students.length)throw new Error("The E-Class table has no learner records to export.");
        if(students.some(function(student){return !student.id||student.values.length!==25})){
          throw new Error("The E-Class table is incomplete. Refresh the record before downloading.");
        }
        var highestScoreRow=table.tHead&&table.tHead.rows[2];
        if(!highestScoreRow)throw new Error("The highest-possible-score row is unavailable.");
        var highestScores=Array.from(highestScoreRow.cells).slice(1).map(function(cell){
          var control=cell.querySelector("input,textarea,select");
          return control?control.value:cell.textContent.trim();
        });
        var response=await fetch("/api/e-class/export",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            term:selectedTerm,
            subject:selectedSubject,
            mapehGroup:selectedMapehGroup,
            section:activeStudentSection,
            highestScores:highestScores,
            students:students
          })
        });
        if(!response.ok){
          var errorResult=await response.json();
          throw new Error(errorResult.error||"Unable to download the E-Class workbook.");
        }
        var disposition=response.headers.get("content-disposition")||"";
        var filenameMatch=disposition.match(/filename="([^"]+)"/i);
        if(!filenameMatch||!/\.xlsx$/i.test(filenameMatch[1]))throw new Error("The server did not provide an Excel workbook filename.");
        var contentType=response.headers.get("content-type")||"";
        if(!/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet(?:;|$)/i.test(contentType)){
          throw new Error("The server response is not an Excel workbook.");
        }
        var blob=await response.blob();
        var objectUrl=URL.createObjectURL(blob);
        var link=document.createElement("a");
        link.href=objectUrl;
        link.download=filenameMatch[1];
        link.style.display="none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
        eClassNotice.classList.remove("error");
        eClassNotice.textContent="E-Class workbook downloaded.";
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not download the E-Class record: "+error.message;
      }finally{
        downloadButton.disabled=false;
        downloadButton.removeAttribute("aria-busy");
      }
    };
    var descriptorColumn=26;
    $("eClassMapehGroupField").hidden=!isMapeh;
    $("eClassSelectionTerm").textContent=selectedTerm;
    $("eClassSelectionSubject").textContent=selectedSubject;
    $("eClassHeadingMapehGroup").hidden=!isMapeh;
    $("eClassHeadingMapehGroupName").textContent=isMapeh?selectedMapehGroup:"";
    $("eClassRecordHeading").setAttribute("aria-label",selectedTerm+", "+selectedSubject
      +(isMapeh?", "+selectedMapehGroup:"")+", Class Record");
    $("eClassTerm").onchange=function(){
      if(eClassDirty&&!window.confirm("Discard unsaved E-Class changes for "+selectedTerm+" · "+selectedSubject+"?")){
        this.value=selectedTerm;
        return;
      }
      renderEClassTable();
    };
    $("eClassSubject").onchange=function(){
      if(eClassDirty&&!window.confirm("Discard unsaved E-Class changes for "+selectedTerm+" · "+selectedSubject+"?")){
        this.value=selectedSubject;
        return;
      }
      renderEClassTable();
    };
    $("eClassMapehGroup").onchange=function(){
      if(eClassDirty&&!window.confirm("Discard unsaved E-Class changes for "+selectedTerm+" · "+selectedSubject+"?")){
        this.value=selectedMapehGroup;
        return;
      }
      renderEClassTable();
    };
    eClassNotice.classList.remove("error");
    eClassNotice.textContent="";
    eClassStudentCount.textContent="Loading students...";
    $("eClassTableWrap").replaceChildren();
    var students;
    try{
      var rosterResult=await api("/api/students");
      if(!Array.isArray(rosterResult.students)){
        throw new Error("The roster response is outdated. Restart the portal server to load the updated backend.");
      }
      students=rosterResult.students;
      students=filterStudentsForActiveSection(students);
    }catch(error){
      eClassStudentCount.textContent="Roster unavailable";
      lockStatus.dataset.locked="";
      lockStatus.textContent="Unable to verify this E-Class record's lock status. Editing is disabled.";
      eClassNotice.classList.add("error");
      eClassNotice.textContent="Could not load the student roster: "+error.message;
      return;
    }
    var eClassRecord;
    try{
      var recordQuery="?term="+encodeURIComponent(selectedTerm)
        +"&subject="+encodeURIComponent(selectedSubject)
        +"&mapehGroup="+encodeURIComponent(selectedMapehGroup)
        +"&section="+encodeURIComponent(selectedSection);
      eClassRecord=await api("/api/e-class/record"+recordQuery);
      recordSaved=eClassRecord.saved===true;
      recordLoading=false;
      updateRecordLockState(eClassRecord.locked===true);
    }catch(error){
      eClassStudentCount.textContent=students.length+" "+(students.length===1?"student":"students");
      lockStatus.dataset.locked="";
      lockStatus.textContent="Unable to verify this E-Class record's lock status. Editing is disabled.";
      eClassNotice.classList.add("error");
      eClassNotice.textContent="Could not load the saved E-Class record: "+error.message;
      return;
    }
    eClassStudentCount.textContent=students.length+" "+(students.length===1?"student":"students");
    var table=document.createElement("table");
    table.className="eclass-table";
    table.setAttribute("aria-label",selectedTerm+" "+selectedSubject+" E-Class record");
    var totalColumns=27;
    var defaultHighestScoreMaxima=["10","15","15","10","15","100","100","100","20","20","40"];
    var highestScoreMaxima=defaultHighestScoreMaxima.slice();
    var subjectWeights=selectedSubject==="EPP / TLE"||selectedSubject==="MAPEH"
      ?{written:20,performance:60,examinations:20}
      :{written:20,performance:50,examinations:30};
    var gradingMethod=["transmuted","zero-based","descriptive"].indexOf(eClassRecord.gradingMethod)!==-1
      ?eClassRecord.gradingMethod:"transmuted";
    var classId=currentUser&&(currentUser.activeClassId||currentUser.id);
    var mapehStorageSuffix=isMapeh?":"+encodeURIComponent(selectedMapehGroup):"";
    var highestScoresStorageKey=classId
      ?"gradePortalEClassHighestScores:"+String(classId)+":"+encodeURIComponent(selectedTerm)+":"+encodeURIComponent(selectedSubject)+mapehStorageSuffix
      :"";
    var highestPossibleScoresStorageAvailable=Boolean(highestScoresStorageKey);
    eClassNotice.classList.remove("error");
    eClassNotice.textContent="";
    if(recordSaved){
      if(Array.isArray(eClassRecord.highestScores)&&eClassRecord.highestScores.length===11
        &&eClassRecord.highestScores.every(function(value){return typeof value==="string"})){
        highestScoreMaxima=eClassRecord.highestScores.slice();
      }else{
        eClassNotice.classList.add("error");
        eClassNotice.textContent="The saved highest-possible-score values are invalid. Unlock the record and correct them before saving.";
      }
    }else if(highestScoresStorageKey){
      try{
        var savedHighestScores=window.localStorage.getItem(highestScoresStorageKey);
        if(savedHighestScores!==null){
          highestScoreMaxima=parseHighestScoreValues(savedHighestScores);
        }
      }catch(error){
        highestPossibleScoresStorageAvailable=false;
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not load saved highest-possible-score values: "+error.message;
      }
    }else{
      highestPossibleScoresStorageAvailable=false;
      eClassNotice.classList.add("error");
      eClassNotice.textContent="Highest-possible-score edits cannot be saved because the active class is unavailable.";
    }
    if(recordSaved&&!recordLocked&&highestScoresStorageKey){
      try{
      var localHighestScores=window.localStorage.getItem(highestScoresStorageKey);
      if(localHighestScores!==null){
        var parsedLocalHighestScores=parseHighestScoreValues(localHighestScores);
        if(JSON.stringify(parsedLocalHighestScores)!==JSON.stringify(highestScoreMaxima))eClassDirty=true;
        highestScoreMaxima=parsedLocalHighestScores;
      }
      }catch(error){
      eClassNotice.classList.add("error");
      eClassNotice.textContent="Could not load the local E-Class draft scores: "+error.message;
      }
    }
    if(!eClassNotice.classList.contains("error")){
      try{
        var removedEClassScores=reconcileEClassScoresWithRoster(students);
        if(removedEClassScores){
          eClassNotice.textContent="Roster refreshed. Cleared saved score inputs for "+removedEClassScores
            +" student"+(removedEClassScores===1?"":"s")+" no longer on this roster.";
        }
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not reconcile saved E-Class inputs with the student roster: "+error.message;
      }
    }
    function highestScoreValues(){
      var wwTotal=highestScoreMaxima.slice(0,5).reduce(function(total,value){return total+(Number(value)||0)},0);
      var ptTotal=highestScoreMaxima.slice(5,8).reduce(function(total,value){return total+(Number(value)||0)},0);
      return highestScoreMaxima.slice(0,5).concat([wwTotal?String(wwTotal):"", "100",subjectWeights.written+"%"])
        .concat(highestScoreMaxima.slice(5,8),[ptTotal?String(ptTotal):"","100",subjectWeights.performance+"%"])
        .concat(highestScoreMaxima.slice(8,11),["30%","30%","40%","100",subjectWeights.examinations+"%"]);
    }
    var head=table.createTHead();
    var groups=head.insertRow();
    function addHeader(row,text,options){
      var cell=document.createElement("th");
      cell.textContent=text;
      if(options&&options.colSpan)cell.colSpan=options.colSpan;
      if(options&&options.rowSpan)cell.rowSpan=options.rowSpan;
      if(options&&options.className)cell.className=options.className;
      if(options&&options.scope)cell.scope=options.scope;
      row.appendChild(cell);
      return cell;
    }
    addHeader(groups,"No.",{rowSpan:2,className:"eclass-student-number",scope:"col"});
    addHeader(groups,"LEARNERS' NAMES",{rowSpan:2,className:"eclass-student-name",scope:"col"});
    addHeader(groups,"WRITTEN / ORAL WORKS (WWs)",{colSpan:8,className:"eclass-group",scope:"colgroup"});
    addHeader(groups,"PRODUCT / PERFORMANCE TASKS (PTs)",{colSpan:6,className:"eclass-group",scope:"colgroup"});
    addHeader(groups,"EXAMINATIONS (EXs)",{colSpan:8,className:"eclass-group",scope:"colgroup"});
    addHeader(groups,isMapeh?"GROUP INITIAL GRADE":"INITIAL GRADE",{rowSpan:3,className:"eclass-grade-cell",scope:"col"});
    if(isMapeh){
      addHeader(groups,selectedMapehGroup.toUpperCase()+" TERM GRADE",{rowSpan:3,className:"eclass-grade-cell",scope:"col"});
    }else{
      addHeader(groups,"TERM GRADE",{rowSpan:3,className:"eclass-grade-cell",scope:"col"});
    }
    addHeader(groups,"DESCRIPTOR",{rowSpan:3,className:"eclass-descriptor",scope:"col"});
    var subheaders=head.insertRow();
    ["1","2","3","4","5","Total","PS","WS","1","2","3","Total","PS","WS","ST1","ST2","TE","WS ST1","WS ST2","WS TE","PS","WS"].forEach(function(label){
      addHeader(subheaders,label,{className:"eclass-category",scope:"col"});
    });
    var scores=head.insertRow();
    scores.setAttribute("aria-label","Highest possible scores");
    addHeader(scores,"HIGHEST POSSIBLE SCORE",{colSpan:2,className:"eclass-highest-score eclass-highest-score-label",scope:"row"});
    var editableMaximumColumns={0:0,1:1,2:2,3:3,4:4,8:5,9:6,10:7,14:8,15:9,16:10};
    highestScoreValues().forEach(function(score,index){
      var isEditable=Object.prototype.hasOwnProperty.call(editableMaximumColumns,index);
      var cell=addHeader(scores,score,{className:"eclass-highest-score"+(isEditable?" eclass-editable-score":" eclass-calculated-cell"),scope:"col"});
      if(isEditable){
        cell.contentEditable="plaintext-only";
        cell.spellcheck=false;
        cell.tabIndex=0;
        cell.setAttribute("inputmode","decimal");
        cell.setAttribute("aria-label","Highest possible score "+(index+1)+", editable");
        cell.dataset.highestPossibleScore=String(editableMaximumColumns[index]);
      }
    });
    var body=table.createTBody();
    var section=body.insertRow();
    var sectionCell=section.insertCell();
    sectionCell.colSpan=totalColumns;
    sectionCell.textContent="LEARNERS' NAMES";
    sectionCell.className="eclass-section";
    var groups=[
      {name:"MALE",students:students.filter(function(student){return student.gender==="Male"})},
      {name:"FEMALE",students:students.filter(function(student){return student.gender==="Female"})},
      {name:"OTHER",students:students.filter(function(student){return student.gender!=="Male"&&student.gender!=="Female"})}
    ].filter(function(group){return group.students.length>0});
    if(groups.length===0){
      var emptyRow=body.insertRow();
      var emptyCell=emptyRow.insertCell();
      emptyCell.colSpan=totalColumns;
      emptyCell.textContent="No students in this class. Add students from the List of Students page.";
    }
    groups.forEach(function(group){
      var genderRow=body.insertRow();
      var genderCell=genderRow.insertCell();
      genderCell.colSpan=totalColumns;
      genderCell.textContent=group.name;
      genderCell.className="eclass-gender";
      group.students.forEach(function(student,index){
        var row=body.insertRow();
        var numberCell=row.insertCell();
        numberCell.textContent=String(index+1);
        numberCell.className="eclass-learner-number";
        var nameCell=row.insertCell();
        nameCell.className="eclass-student-name";
        nameCell.textContent=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
        for(var column=2;column<totalColumns;column++){
          var scoreCell=row.insertCell();
          var isScoreInput=[2,3,4,5,6,10,11,12,16,17,18].includes(column);
          scoreCell.className=(column===7||column===8||column===9||column===13||column===14||column===15
            ||column>=19)?"eclass-calculated-cell eclass-score-cell"+(isScoreInput?" eclass-input-cell":"")
            :"eclass-score-cell"+(isScoreInput?" eclass-input-cell":"");
          scoreCell.dataset.resultColumn=String(column);
          if([2,3,4,5,6,10,11,12,16,17,18].includes(column)){
            scoreCell.replaceChildren();
            var scoreInput=document.createElement("input");
            scoreInput.type="text";
            scoreInput.inputMode="decimal";
            scoreInput.autocomplete="off";
            scoreInput.className="eclass-score-input";
            scoreInput.dataset.scoreIndex=String([2,3,4,5,6,10,11,12,16,17,18].indexOf(column));
            scoreInput.setAttribute("aria-label",student.lastName+", "+student.firstName+" "+student.middleName+" score "+scoreInput.dataset.scoreIndex);
            scoreCell.appendChild(scoreInput);
          }
        }
        row.dataset.studentId=String(student.id);
        row.dataset.studentName=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
        if(student.enrollmentStatus){
          row.dataset.inactive="true";
          row.className="eclass-row-inactive";
          nameCell.title="Locked: tagged "+student.enrollmentStatus+" on the Attendance page";
          var lockTag=document.createElement("span");
          lockTag.className="student-status-tag "+(student.enrollmentStatus==="NLS"?"nls":"to");
          lockTag.textContent="🔒 "+(student.enrollmentStatus==="NLS"?"NLS":"TO")+" · locked";
          nameCell.appendChild(document.createElement("br"));
          nameCell.appendChild(lockTag);
          row.querySelectorAll("input").forEach(function(input){input.disabled=true});
        }
      });
    });
    var highestScoresByColumn=[0,1,2,3,4,5,6,7,8,9,10];
    function numberFromCell(value){
      if(value===null||value===undefined||String(value).trim()==="")return null;
      var parsed=Number(value);
      return Number.isFinite(parsed)?parsed:null;
    }
    function rounded(value){return Number(value.toFixed(2))}
    function refreshHighestScoreValues(){
      var values=highestScoreValues();
      Array.from(scores.cells).slice(1).forEach(function(cell,index){
        if(!cell.hasAttribute("contenteditable"))cell.textContent=values[index];
      });
      table.querySelectorAll("input[data-score-index]").forEach(function(input){
        var maximum=numberFromCell(highestScoreMaxima[Number(input.dataset.scoreIndex)]);
        if(maximum===null||maximum<=0)input.removeAttribute("max");
        else input.max=String(maximum);
        if(!Object.prototype.hasOwnProperty.call(input.dataset,"lastValidScore")){
          input.dataset.lastValidScore=input.value.trim();
        }
      });
    }
    function setResult(row,column,value){
      row.cells[column].textContent=value===null||value===undefined?"":String(value);
    }
    function updateStudentRow(row){
      var inputs=Array.from(row.querySelectorAll("input[data-score-index]"));
      var earned=inputs.map(function(input){return numberFromCell(input.value)});
      var maxima=highestScoreMaxima.map(numberFromCell);
      var invalidIndex=inputs.findIndex(function(input,index){
        var score=earned[index],maximum=maxima[index],scoreText=input.value.trim();
        return scoreText!==""&&(score===null||score<0||maximum===null||maximum<=0||score>maximum);
      });
      if(invalidIndex!==-1){
        var invalidScore=earned[invalidIndex],invalidMaximum=maxima[invalidIndex];
        eClassNotice.classList.add("error");
        eClassNotice.textContent=invalidScore===null||invalidScore<0
          ?"Enter a valid non-negative score for "+row.dataset.studentName+"."
          :invalidMaximum===null||invalidMaximum<=0
          ?"Enter a positive highest possible score before recording "+row.dataset.studentName+"'s score."
          :row.dataset.studentName+"'s score cannot exceed the highest possible score of "+invalidMaximum+".";
        [7,8,9,13,14,15,19,20,21,22,23,24].forEach(function(column){setResult(row,column,"")});
        [25,26].forEach(function(column){setResult(row,column,"")});
        return false;
      }
      function calculateComponent(startIndex,count,weight,totalColumn,percentageColumn,weightedColumn){
        var active=[];
        for(var index=startIndex;index<startIndex+count;index++){
          if(maxima[index]!==null&&maxima[index]>0)active.push(index);
        }
        var hasEntries=active.some(function(index){return earned[index]!==null});
        var totalScore=active.reduce(function(total,index){return total+(earned[index]||0)},0);
        var totalMaximum=active.reduce(function(total,index){return total+maxima[index]},0);
        setResult(row,totalColumn,hasEntries?rounded(totalScore):"");
        if(active.length===0||active.some(function(index){return earned[index]===null})){
          setResult(row,percentageColumn,"");
          setResult(row,weightedColumn,"");
          return {complete:false,weighted:null};
        }
        var percentage=totalScore/totalMaximum*100;
        var weighted=percentage*weight/100;
        setResult(row,percentageColumn,rounded(percentage));
        setResult(row,weightedColumn,rounded(weighted));
        return {complete:true,weighted:weighted};
      }
      var written=calculateComponent(0,5,subjectWeights.written,7,8,9);
      var performance=calculateComponent(5,3,subjectWeights.performance,13,14,15);
      var examIndexes=[8,9,10];
      var examWeights=[30,30,40];
      var activeExams=examIndexes.filter(function(index){return maxima[index]!==null&&maxima[index]>0});
      var examsComplete=activeExams.length>0&&activeExams.every(function(index){return earned[index]!==null});
      var examContributions=[];
      examIndexes.forEach(function(index,examNumber){
        var score=earned[index],maximum=maxima[index];
        if(score===null||maximum===null||maximum<=0){
          setResult(row,19+examNumber,"");
          return;
        }
        var contribution=score/maximum*100*examWeights[examNumber]/100;
        examContributions.push({examNumber:examNumber,contribution:contribution});
        setResult(row,19+examNumber,rounded(contribution));
      });
      var examPercentage=null,examWeighted=null;
      if(examsComplete){
        var activeWeight=activeExams.reduce(function(total,index){
          return total+examWeights[index-8];
        },0);
        examPercentage=examContributions.reduce(function(total,exam){return total+exam.contribution},0)
          /activeWeight*100;
        examWeighted=examPercentage*subjectWeights.examinations/100;
        setResult(row,22,rounded(examPercentage));
        setResult(row,23,rounded(examWeighted));
      }else{
        setResult(row,22,"");
        setResult(row,23,"");
      }
      if(written.complete&&performance.complete&&examsComplete){
        var initialGrade=written.weighted+performance.weighted+examWeighted;
        setResult(row,24,rounded(initialGrade));
        var grade=eClassGradeForInitial(initialGrade,gradingMethod);
        setResult(row,25,grade.termGrade);
        setResult(row,26,grade.descriptor);
      }else{
        setResult(row,24,"");
        [25,26].forEach(function(column){setResult(row,column,"")});
      }
      return true;
    }
    function persistHighestScores(){
      if(!highestPossibleScoresStorageAvailable)throw new Error("Highest possible scores cannot be saved because the active class is unavailable.");
      window.localStorage.setItem(highestScoresStorageKey,JSON.stringify(highestScoreMaxima));
    }
    function persistStudentScores(row){
      if(!classId)throw new Error("Student scores cannot be saved because the active class is unavailable.");
      var key="gradePortalEClassScores:"+String(classId)+":"+encodeURIComponent(selectedTerm)+":"
        +encodeURIComponent(selectedSubject)+mapehStorageSuffix+":"+encodeURIComponent(row.dataset.studentId);
      var values=Array.from(row.querySelectorAll("input[data-score-index]")).map(function(input){return input.value.trim()});
      window.localStorage.setItem(key,JSON.stringify(values));
    }
    var eClassDraftTimer=null;
    var eClassDraftSaving=false;
    var eClassDraftQueued=false;
    window.flushEClassDraftSave=async function(){
      window.clearTimeout(eClassDraftTimer);
      if(!eClassDirty||recordLocked||recordLoading)return;
      var studentRows=Array.from(table.querySelectorAll("tbody tr[data-student-id]"));
      await api("/api/e-class/draft",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          term:selectedTerm,
          subject:selectedSubject,
          mapehGroup:selectedMapehGroup,
          section:selectedSection,
          highestScores:highestScoreMaxima,
          students:studentRows.map(function(row){
            return {
              id:row.dataset.studentId,
              scores:Array.from(row.querySelectorAll("input[data-score-index]")).map(function(input){return input.value.trim()}),
              grade:""
            };
          })
        })
      });
    };
    function queueEClassDraftSave(){
      eClassDraftQueued=true;
      if(eClassDraftSaving)return;
      window.clearTimeout(eClassDraftTimer);
      eClassDraftTimer=window.setTimeout(async function(){
        if(eClassDraftSaving)return;
        eClassDraftSaving=true;
        try{
          var studentRows=Array.from(table.querySelectorAll("tbody tr[data-student-id]"));
          await api("/api/e-class/draft",{
            method:"PUT",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              term:selectedTerm,
              subject:selectedSubject,
              mapehGroup:selectedMapehGroup,
              section:selectedSection,
              highestScores:highestScoreMaxima,
              students:studentRows.map(function(row){
                return {
                  id:row.dataset.studentId,
                  scores:Array.from(row.querySelectorAll("input[data-score-index]")).map(function(input){return input.value.trim()}),
                  grade:""
                };
              })
            })
          });
          eClassDraftQueued=false;
          eClassNotice.classList.remove("error");
          eClassNotice.textContent="E-Class draft saved to the local database. It will remain after sign out.";
        }catch(error){
          eClassNotice.classList.add("error");
          eClassNotice.textContent="Could not save the E-Class draft to the backend: "+error.message;
        }finally{
          eClassDraftSaving=false;
          if(eClassDraftQueued)queueEClassDraftSave();
        }
      },350);
    }
    table.addEventListener("input",function(event){
      var maximumCell=event.target.closest("th[data-highest-possible-score]");
      if(maximumCell){
        var maximumIndex=Number(maximumCell.dataset.highestPossibleScore);
        var maximumText=maximumCell.textContent.trim();
        var maximumValue=numberFromCell(maximumText);
        if(maximumText!==""&&(maximumValue===null||maximumValue<=0)){
          maximumCell.textContent=String(highestScoreMaxima[maximumIndex]||"");
          eClassNotice.classList.add("error");
          eClassNotice.textContent="Highest possible scores must be positive numbers or left blank.";
          return;
        }
        eClassDirty=true;
        highestScoreMaxima[maximumIndex]=maximumText;
        refreshHighestScoreValues();
        var studentRows=Array.from(body.querySelectorAll("tr[data-student-id]"));
        var invalidScoreCount=0;
        studentRows.forEach(function(row){
          row.querySelectorAll("input[data-score-index]").forEach(function(input){
            var validationMessage=eClassScoreValidationMessage(
              input.value,
              highestScoreMaxima[Number(input.dataset.scoreIndex)]
            );
            if(validationMessage&&input.value.trim()!==""){
              input.dataset.lastValidScore="";
              invalidScoreCount++;
            }
          });
          updateStudentRow(row);
        });
        try{
          persistHighestScores();
          queueEClassDraftSave();
          if(invalidScoreCount){
            eClassNotice.classList.add("error");
            eClassNotice.textContent="Draft highest scores updated. "+invalidScoreCount
              +" learner score"+(invalidScoreCount===1?" is":"s are")
              +" invalid under the updated maximum and were kept unchanged. Adjust them or update the maximum before saving.";
          }else{
            eClassNotice.classList.remove("error");
            eClassNotice.textContent="Draft highest scores updated. Select Save & Lock Record to save changes.";
          }
        }catch(error){
          eClassNotice.classList.add("error");
          eClassNotice.textContent="Could not save highest possible scores: "+error.message;
        }
        return;
      }
      var scoreInput=event.target.closest("input[data-score-index]");
      if(!scoreInput)return;
      var row=scoreInput.closest("tr[data-student-id]");
      var scoreValidationMessage=eClassScoreValidationMessage(
        scoreInput.value,
        highestScoreMaxima[Number(scoreInput.dataset.scoreIndex)]
      );
      if(scoreValidationMessage){
        scoreInput.value=scoreInput.dataset.lastValidScore||"";
        eClassNotice.classList.add("error");
        eClassNotice.textContent=row.dataset.studentName+": "+scoreValidationMessage;
        return;
      }
      scoreInput.dataset.lastValidScore=scoreInput.value.trim();
      if(!updateStudentRow(row))return;
      eClassDirty=true;
      try{
        persistStudentScores(row);
        queueEClassDraftSave();
        eClassNotice.classList.remove("error");
        eClassNotice.textContent="Draft scores saved in this browser for "+row.dataset.studentName+". Select Save & Lock Record to save changes.";
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not save scores for "+row.dataset.studentName+": "+error.message;
      }
    });
    refreshHighestScoreValues();
    Array.from(body.querySelectorAll("tr[data-student-id]")).forEach(function(row){
      if(!classId){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Learner scores cannot be saved because the active class is unavailable.";
        return;
      }
      try{
        var storedScores=eClassRecord.scores&&eClassRecord.scores[row.dataset.studentId];
        var rowScores=storedScores;
        if(rowScores!==undefined&&rowScores!==null){
          if(!Array.isArray(rowScores)||rowScores.length!==11
            ||rowScores.some(function(score){return typeof score!=="string"})){
            throw new Error("Saved learner score data is invalid.");
          }
          row.querySelectorAll("input[data-score-index]").forEach(function(input){
            input.value=rowScores[Number(input.dataset.scoreIndex)];
            if(eClassScoreValidationMessage(
              input.value,
              highestScoreMaxima[Number(input.dataset.scoreIndex)]
            )){
              input.dataset.lastValidScore="";
            }else{
              input.dataset.lastValidScore=input.value.trim();
            }
          });
        }
        updateStudentRow(row);
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not load saved scores for "+row.dataset.studentName+": "+error.message;
      }
    });
    recordTable=table;
    $("eClassTableWrap").replaceChildren(table);
    updateRecordLockState(recordLocked);
    if(eClassDirty&&!eClassNotice.classList.contains("error")){
      eClassNotice.textContent="Unsaved E-Class draft changes are available. Select Save & Lock Record to update the backend.";
    }
    downloadButton.disabled=false;
    saveButton.onclick=async function(){
      if(recordSaving||recordLocked||recordLoading)return;
      var studentRows=Array.from(table.querySelectorAll("tbody tr[data-student-id]"));
      if(!studentRows.length){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="There are no learner scores to save.";
        return;
      }
      recordSaving=true;
      saveButton.setAttribute("aria-busy","true");
      saveButton.textContent="Saving & Locking...";
      updateRecordLockState(recordLocked);
      try{
        var response=await api("/api/e-class/record",{
          method:"PUT",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            term:selectedTerm,
            subject:selectedSubject,
            mapehGroup:selectedMapehGroup,
            section:selectedSection,
            highestScores:highestScoreMaxima,
            students:studentRows.map(function(row){
              return {
                id:row.dataset.studentId,
                scores:Array.from(row.querySelectorAll("input[data-score-index]")).map(function(input){return input.value.trim()}),
                grade:row.cells[25].textContent.trim()
              };
            })
          })
        });
        recordSaved=true;
        eClassDirty=false;
        updateRecordLockState(response.locked===true);
        eClassNotice.classList.remove("error");
        eClassNotice.textContent="E-Class scores and calculated Term Grades saved. The selected record is now locked.";
      }catch(error){
        eClassNotice.classList.add("error");
        eClassNotice.textContent="Could not save and lock the E-Class record: "+error.message;
      }finally{
        recordSaving=false;
        saveButton.removeAttribute("aria-busy");
        saveButton.textContent="Save & Lock Record";
        updateRecordLockState(recordLocked);
      }
    };
    unlockButton.onclick=function(){
      if(!recordLocked||recordSaving)return;
      $("eClassUnlockDescription").textContent="Enter your current teacher password to unlock "
        +selectedTerm+" · "+selectedSubject+(isMapeh?" · "+selectedMapehGroup:"")+" for editing.";
      $("eClassUnlockError").textContent="";
      $("eClassUnlockForm").reset();
      $("eClassUnlockDialog").showModal();
      $("eClassUnlockPassword").focus();
    };
    $("closeEClassUnlockDialog").onclick=function(){$("eClassUnlockDialog").close()};
    $("cancelEClassUnlock").onclick=function(){$("eClassUnlockDialog").close()};
    $("eClassUnlockDialog").onclose=function(){
      $("eClassUnlockForm").reset();
      $("eClassUnlockError").textContent="";
    };
    $("eClassUnlockForm").onsubmit=async function(event){
      event.preventDefault();
      if(!recordLocked||recordSaving)return;
      recordSaving=true;
      $("confirmEClassUnlock").disabled=true;
      $("confirmEClassUnlock").textContent="Verifying...";
      updateRecordLockState(recordLocked);
      try{
        var result=await api("/api/e-class/record/unlock",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            term:selectedTerm,
            subject:selectedSubject,
            mapehGroup:selectedMapehGroup,
            section:selectedSection,
            password:$("eClassUnlockPassword").value
          })
        });
        recordSaved=true;
        eClassDirty=false;
        updateRecordLockState(result.locked===true);
        $("eClassUnlockDialog").close();
        eClassNotice.classList.remove("error");
        eClassNotice.textContent="E-Class record unlocked. Edit scores, then select Save & Lock Record to save and lock your changes.";
      }catch(error){
        $("eClassUnlockError").textContent=error.message;
        $("eClassUnlockPassword").focus();
      }finally{
        recordSaving=false;
        $("confirmEClassUnlock").disabled=false;
        $("confirmEClassUnlock").textContent="Unlock record";
        updateRecordLockState(recordLocked);
      }
    };
  }

  var sf10GradeSubjects=[
    ["Language","Reading and Literacy","Mathematics","GMRC (Good Manners and Right Conduct)","Makabansa","*Arabic Language","*Islamic Values Education"],
    ["Filipino","English","Mathematics","GMRC (Good Manners and Right Conduct)","Makabansa","*Arabic Language","*Islamic Values Education"],
    ["Filipino","English","Mathematics","Science","GMRC (Good Manners and Right Conduct)","Makabansa","*Arabic Language","*Islamic Values Education"],
    ["Filipino","English","Mathematics","GMRC (Good Manners and Right Conduct)","Araling Panlipunan","EPP","MAPEH","Music & Arts","Physical Education & Health","*Arabic Language","*Islamic Values Education"],
    ["Filipino","English","Mathematics","Science","GMRC (Good Manners and Right Conduct)","Araling Panlipunan","EPP","MAPEH","Music & Arts","Physical Education & Health","*Arabic Language","*Islamic Values Education"],
    ["Filipino","English","Mathematics","Science","GMRC (Good Manners and Right Conduct)","Araling Panlipunan","TLE","MAPEH","Music & Arts","Physical Education & Health","*Arabic Language","*Islamic Values Education"]
  ];

  function sf10FieldMarkup(label,key,type,placeholder,className){
    var id="sf10_"+key.replace(/[^a-zA-Z0-9]+/g,"_");
    return '<div class="sf10-field'+(className?" "+className:"")+'"><label for="'+id+'">'+label+'</label><input id="'+id+'" type="'+(type||"text")+'" data-sf10-field="'+key+'"'+(placeholder?' placeholder="'+placeholder+'"':"")+'></div>';
  }

  function renderSf10GradeCards(){
    var front=$("sf10FrontGrades");
    var back=$("sf10BackGrades");
    front.replaceChildren();
    back.replaceChildren();
    sf10GradeSubjects.forEach(function(subjects,index){
      var grade=index+1;
      var root=grade<=4?front:back;
      var card=document.createElement("section");
      card.className="sf10-grade-card";
      card.setAttribute("aria-labelledby","sf10GradeTitle"+grade);
      var subjectRows=subjects.slice();
      while(subjectRows.length<15)subjectRows.splice(subjectRows.length-2,0,"");
      var rows=subjectRows.map(function(subject,subjectIndex){
        var base="grade."+grade+".subjects."+subjectIndex;
        var subjectName=subject
          ?subject
          :'<input aria-label="Grade '+grade+' additional learning area '+(subjectIndex+1)+'" data-sf10-field="'+base+'.name">';
        return "<tr><td>"+subjectName+"</td>"
          +[1,2,3].map(function(term){return '<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="'+subject+" Term "+term+'" data-sf10-field="'+base+".q"+term+'"></td>';}).join("")
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="'+(subject||"Additional learning area")+' final rating" data-sf10-field="'+base+'.final"></td>'
          +'<td><input aria-label="'+(subject||"Additional learning area")+' remarks" data-sf10-field="'+base+'.remarks"></td></tr>';
      }).join("");
      var remedialRows=[0,1,2].map(function(subjectIndex){
        var base="grade."+grade+".remedial."+subjectIndex;
        return '<tr><td><input aria-label="Grade '+grade+' remedial learning area '+(subjectIndex+1)+'" data-sf10-field="'+base+'.subject"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Remedial final rating" data-sf10-field="'+base+'.final"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Remedial class mark" data-sf10-field="'+base+'.mark"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Recomputed final grade" data-sf10-field="'+base+'.recomputed"></td>'
          +'<td><input aria-label="Remedial remarks" data-sf10-field="'+base+'.remarks"></td></tr>';
      }).join("");
      card.innerHTML='<header class="sf10-grade-heading"><h3 id="sf10GradeTitle'+grade+'">Grade '+grade+'</h3><span>School year record</span></header>'
        +'<div class="sf10-grade-meta">'
        +sf10FieldMarkup("School","grade."+grade+".school","text","","sf10-meta-span-3")
        +sf10FieldMarkup("School ID","grade."+grade+".schoolId")
        +sf10FieldMarkup("District","grade."+grade+".district","text","","sf10-meta-span-2")
        +sf10FieldMarkup("Division","grade."+grade+".division")
        +sf10FieldMarkup("Region","grade."+grade+".region")
        +sf10FieldMarkup("Classified as Grade","grade."+grade+".classifiedGrade","text",String(grade))
        +sf10FieldMarkup("Section","grade."+grade+".section")
        +sf10FieldMarkup("School Year","grade."+grade+".schoolYear","text","","sf10-meta-span-2")
        +sf10FieldMarkup("Name of Adviser/Teacher","grade."+grade+".adviser","text","","sf10-meta-span-3")
        +sf10FieldMarkup("Signature","grade."+grade+".signature")
        +'</div><div class="sf10-table-wrap"><table class="sf10-table sf10-grade-table"><colgroup><col class="sf10-subject-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-remarks-col"></colgroup><thead><tr><th rowspan="2">Learning Areas</th><th colspan="3">Term</th><th rowspan="2">Final Rating</th><th rowspan="2">Remarks</th></tr><tr><th>1</th><th>2</th><th>3</th></tr></thead><tbody>'
        +rows+'<tr class="sf10-average-row"><td colspan="4">General Average</td><td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Grade '+grade+' general average" data-sf10-field="grade.'+grade+'.generalAverage"></td><td><input aria-label="Grade '+grade+' general average remarks" data-sf10-field="grade.'+grade+'.generalAverageRemarks" readonly aria-readonly="true" title="Generated from SF9 Term Grades."></td></tr>'
        +'</tbody></table></div><div class="sf10-remedial"><h4>Remedial Classes</h4><div class="sf10-remedial-dates">'
        +sf10FieldMarkup("Conducted from","grade."+grade+".remedialFrom","date")
        +sf10FieldMarkup("To","grade."+grade+".remedialTo","date")
        +'</div><div class="sf10-table-wrap"><table class="sf10-table sf10-remedial-table"><colgroup><col class="sf10-subject-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-remarks-col"></colgroup><thead><tr><th>Learning Areas</th><th>Final Rating</th><th>Remedial Class Mark</th><th>Recomputed Final Grade</th><th>Remarks</th></tr></thead><tbody>'
        +remedialRows+'</tbody></table></div></div>';
      root.appendChild(card);
    });
    renderSf10AdditionalRecords();
  }

  function renderSf10AdditionalRecords(){
    var root=$("sf10AdditionalRecords");
    root.replaceChildren();
    [1,2].forEach(function(recordNumber){
      var base="additionalRecord."+recordNumber;
      var rows=Array.from({length:16},function(_,index){
        var subjectKey=base+".subjects."+index;
        return '<tr><td><input aria-label="Additional record '+recordNumber+' learning area '+(index+1)+'" data-sf10-field="'+subjectKey+'.name"></td>'
          +[1,2,3].map(function(term){return '<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Additional record term rating" data-sf10-field="'+subjectKey+".q"+term+'"></td>';}).join("")
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Additional record final rating" data-sf10-field="'+subjectKey+'.final"></td>'
          +'<td><input aria-label="Additional record remarks" data-sf10-field="'+subjectKey+'.remarks"></td></tr>';
      }).join("");
      var remedialRows=Array.from({length:2},function(_,index){
        var remedialKey=base+".remedial."+index;
        return '<tr><td><input aria-label="Additional record remedial learning area '+(index+1)+'" data-sf10-field="'+remedialKey+'.subject"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Additional record remedial final rating" data-sf10-field="'+remedialKey+'.final"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Additional record remedial class mark" data-sf10-field="'+remedialKey+'.mark"></td>'
          +'<td><input type="number" min="60" max="100" step="1" inputmode="numeric" aria-label="Additional record recomputed final grade" data-sf10-field="'+remedialKey+'.recomputed"></td>'
          +'<td><input aria-label="Additional record remedial remarks" data-sf10-field="'+remedialKey+'.remarks"></td></tr>';
      }).join("");
      var card=document.createElement("section");
      card.className="sf10-additional-record";
      card.innerHTML='<div class="sf10-grade-meta">'
        +sf10FieldMarkup("School",base+".school","text","","sf10-meta-span-3")
        +sf10FieldMarkup("School ID",base+".schoolId")
        +sf10FieldMarkup("District",base+".district","text","","sf10-meta-span-2")
        +sf10FieldMarkup("Division",base+".division")
        +sf10FieldMarkup("Region",base+".region")
        +sf10FieldMarkup("Classified Grade",base+".classifiedGrade")
        +sf10FieldMarkup("Section",base+".section")
        +sf10FieldMarkup("School Year",base+".schoolYear","text","","sf10-meta-span-2")
        +sf10FieldMarkup("Adviser/Teacher",base+".adviser","text","","sf10-meta-span-3")
        +sf10FieldMarkup("Signature",base+".signature")
        +'</div><div class="sf10-table-wrap"><table class="sf10-table sf10-grade-table"><colgroup><col class="sf10-subject-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-remarks-col"></colgroup><thead><tr><th rowspan="2">Learning Areas</th><th colspan="3">Term</th><th rowspan="2">Final Rating</th><th rowspan="2">Remarks</th></tr><tr><th>1</th><th>2</th><th>3</th></tr></thead><tbody>'
        +rows+'<tr class="sf10-average-row"><td colspan="4">General Average</td><td><input type="number" min="60" max="100" step="1" inputmode="numeric" data-sf10-field="'+base+'.generalAverage"></td><td><input aria-label="Additional record general average remarks" data-sf10-field="'+base+'.generalAverageRemarks" readonly aria-readonly="true" title="Generated from SF9 Term Grades."></td></tr></tbody></table></div>'
        +'<div class="sf10-remedial"><h4>Remedial Classes</h4><div class="sf10-remedial-dates">'
        +sf10FieldMarkup("Date Conducted From",base+".remedialFrom","date")
        +sf10FieldMarkup("To",base+".remedialTo","date")
        +'</div><div class="sf10-table-wrap"><table class="sf10-table sf10-remedial-table"><colgroup><col class="sf10-subject-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-grade-col"><col class="sf10-remarks-col"></colgroup><thead><tr><th>Learning Areas</th><th>Final Rating</th><th>Remedial Class Mark</th><th>Recomputed Final Grade</th><th>Remarks</th></tr></thead><tbody>'
        +remedialRows+'</tbody></table></div></div>';
      root.appendChild(card);
    });
  }

  function renderSf10Certifications(){
    var root=$("sf10Certifications");
    root.replaceChildren();
    [1,2,3].forEach(function(index){
      var certification=index+1;
      var base="certification."+certification;
      var card=document.createElement("section");
      card.className="sf10-cert-card";
      card.innerHTML='<h3>Certification</h3><p class="sf10-cert-statement">I CERTIFY that this is a true record of the learner <input aria-label="Certification learner name" data-sf10-field="'+base+'.learnerName'+'"> with LRN <input aria-label="Certification LRN" data-sf10-field="'+base+'.lrn'+'"> and that he/she is eligible for admission to Grade <input aria-label="Eligible for admission to Grade" data-sf10-field="'+base+'.eligibleGrade'+'">.</p><div class="sf10-fields">'
        +sf10FieldMarkup("School Name",base+".school")
        +sf10FieldMarkup("School ID",base+".schoolId")
        +sf10FieldMarkup("Division",base+".division")
        +sf10FieldMarkup("Last School Year Attended",base+".lastSchoolYear")
        +'</div><div class="sf10-cert-signatures"><span>Date<br><input type="date" aria-label="Certification date" data-sf10-field="'+base+'.date"></span><span>Signature of Principal/School Head over Printed Name<br><input aria-label="Principal or school head name" data-sf10-field="'+base+'.principal'+'"></span><span>(Affix School Seal here)</span></div>';
      root.appendChild(card);
    });
  }

  function sf10SetStatus(message,isError){
    var status=$("sf10SaveStatus");
    status.textContent=message||"";
    status.classList.toggle("error",Boolean(isError));
  }

  function sf10StorageKey(){
    var userKey=currentUser&&(currentUser.id||currentUser.username||currentUser.email)||"portal-user";
    var classKey=currentUser&&(currentUser.activeClassId||currentUser.classId||currentUser.classCode)||"default-class";
    return "gracedesk-sf10-v1:"+String(userKey)+":"+String(classKey);
  }

  function sf10ReadRecords(){
    var raw=window.localStorage.getItem(sf10StorageKey());
    if(!raw)return {};
    var records;
    try{
      records=JSON.parse(raw);
    }catch(error){
      throw new Error("The saved SF 10 drafts could not be read. Browser storage contains invalid data.");
    }
    if(!records||typeof records!=="object"||Array.isArray(records)){
      throw new Error("The saved SF 10 drafts have an unexpected format.");
    }
    return records;
  }

  function sf10CollectFields(){
    var data={};
    $("sf10Form").querySelectorAll("[data-sf10-field]").forEach(function(field){
      data[field.dataset.sf10Field]=field.type==="checkbox"?field.checked:field.value;
    });
    return data;
  }

  function sf10ApplyFields(data){
    $("sf10Form").querySelectorAll("[data-sf10-field]").forEach(function(field){
      var value=data[field.dataset.sf10Field];
      if(field.type==="checkbox")field.checked=value===true;
      else field.value=value===undefined||value===null?"":String(value);
    });
  }

  function sf10PersistRecord(recordKey){
    try{
      var records=sf10ReadRecords();
      records[recordKey||sf10ActiveRecordKey]={fields:sf10CollectFields(),updatedAt:new Date().toISOString()};
      window.localStorage.setItem(sf10StorageKey(),JSON.stringify(records));
      var savedAt=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
      sf10SetStatus("Draft saved in this browser at "+savedAt+".",false);
      return true;
    }catch(error){
      sf10SetStatus("Could not save this SF 10 draft: "+error.message,true);
      return false;
    }
  }

  function sf10RosterFields(student){
    var fields={
      "learner.lastName":student.lastName||"",
      "learner.firstName":student.firstName||"",
      "learner.middleName":student.middleName||"",
      "learner.lrn":student.lrn||"",
      "learner.birthdate":student.birthdate?String(student.birthdate).slice(0,10):"",
      "learner.sex":student.gender||""
    };
    sf10GradeSubjects.forEach(function(_,index){fields["grade."+(index+1)+".classifiedGrade"]=String(index+1)});
    return fields;
  }

  function sf10ClassifiedGradeIndex(classifiedGrades,classGrade){
    function gradeNumber(value){
      var match=/^(?:grade\s*)?([1-6])$/i.exec(String(value||"").trim());
      return match?Number(match[1]):0;
    }
    var targetGrade=gradeNumber(classGrade);
    if(!targetGrade)return -1;
    var matches=[];
    classifiedGrades.forEach(function(value,index){
      if(gradeNumber(value)===targetGrade)matches.push(index);
    });
    return matches.length===1?matches[0]:-1;
  }

  function sf10TermGradeFields(gradeIndex,termResults,generalAverageSubjects){
    var subjects=sf10GradeSubjects[gradeIndex];
    if(!subjects)return {};
    var aliases={
      gmrc:["gmrc","goodmannersandrightconduct"],
      epp:["epp"],
      epptle:["epp","tle"],
      tle:["tle"],
      musicandarts:["musicarts"],
      physicaleducationandhealth:["physicaleducationhealth"]
    };
    var fields={};
    var termGradesBySubject=[];
    var subjectTermGrades={};
    subjects.forEach(function(_,subjectIndex){
      var base="grade."+(gradeIndex+1)+".subjects."+subjectIndex;
      fields[base+".q1"]="";
      fields[base+".q2"]="";
      fields[base+".q3"]="";
      fields[base+".final"]="";
      fields[base+".remarks"]="";
    });
    termResults.slice(0,3).forEach(function(result,termIndex){
      if(!result||!result.grades||typeof result.grades!=="object"){
        throw new Error("A Term Grades response did not contain subject grades.");
      }
      var sourceGrades=result.grades;
      var music=Number(sourceGrades.musicAndArts);
      var physicalEducation=Number(sourceGrades.physicalEducationAndHealth);
      var hasMapeh=sourceGrades.musicAndArts!==""&&sourceGrades.musicAndArts!==null
        &&sourceGrades.musicAndArts!==undefined
        &&sourceGrades.physicalEducationAndHealth!==""&&sourceGrades.physicalEducationAndHealth!==null
        &&sourceGrades.physicalEducationAndHealth!==undefined
        &&Number.isFinite(music)&&Number.isFinite(physicalEducation);
      var termGrades=Object.assign({},sourceGrades,{
        mapeh:hasMapeh?String(Math.round(((music+physicalEducation)/2)*100)/100):""
      });
      termGradesBySubject.push(termGrades);
      Object.keys(termGrades).forEach(function(subjectKey){
        var key=subjectKey.replace(/[^a-zA-Z0-9]/g,"").toLowerCase();
        var names=aliases[key]||[key];
        var subjectIndex=subjects.findIndex(function(subject){
          var normalized=subject.replace(/[^a-zA-Z0-9]/g,"").toLowerCase();
          return names.some(function(name){return normalized.indexOf(name)!==-1});
        });
        if(subjectIndex<0)return;
        var value=termGrades[subjectKey];
        var base="grade."+(gradeIndex+1)+".subjects."+subjectIndex;
        fields[base+".q"+(termIndex+1)]=value===null||value===undefined?"":String(value);
        var numericValue=value!==null&&value!==undefined&&String(value).trim()!==""?Number(value):NaN;
        (subjectTermGrades[subjectIndex]||(subjectTermGrades[subjectIndex]=[]))[termIndex]
          =Number.isFinite(numericValue)?numericValue:null;
      });
    });
    Object.keys(subjectTermGrades).forEach(function(subjectIndex){
      var grades=subjectTermGrades[subjectIndex];
      var base="grade."+(gradeIndex+1)+".subjects."+subjectIndex;
      var finalGrade=grades.length===3&&[0,1,2].every(function(index){return Number.isFinite(grades[index])})
        ?Math.round(grades.reduce(function(total,value){return total+value},0)/grades.length)
        :null;
      fields[base+".final"]=finalGrade===null?"":String(finalGrade);
      fields[base+".remarks"]=finalGrade===null?"":finalGrade>=75?"Passed":"Failed";
    });
    var annualSubjectGrades=Array.isArray(generalAverageSubjects)
      ?generalAverageSubjects.map(function(subjectKey){
        var grades=termGradesBySubject.map(function(termGrades){
          var value=termGrades[subjectKey];
          var numericValue=value!==null&&value!==undefined&&String(value).trim()!==""?Number(value):NaN;
          return Number.isFinite(numericValue)?numericValue:null;
        });
        return grades.length===3&&grades.every(function(value){return typeof value==="number"})
          ?Math.round(grades.reduce(function(total,value){return total+value},0)/grades.length)
          :null;
      })
      :[];
    var generalAverage=annualSubjectGrades.length&&annualSubjectGrades.every(function(value){return typeof value==="number"})
      ?Math.round(annualSubjectGrades.reduce(function(total,value){return total+value},0)/annualSubjectGrades.length)
      :null;
    var generalAverageBase="grade."+(gradeIndex+1)+".generalAverage";
    fields[generalAverageBase]=generalAverage===null?"":String(generalAverage);
    fields[generalAverageBase+"Remarks"]=generalAverage===null?"":generalAverage>=75?"Passed":"Failed";
    return fields;
  }

  function sf10LockGradeInputs(gradeIndex,form){
    var base="grade."+(gradeIndex+1)+".";
    var subjectPrefix=base+"subjects.";
    form.querySelectorAll("[data-sf10-field]").forEach(function(field){
      var key=field.dataset.sf10Field;
      if(key===base+"generalAverage"||key===base+"generalAverageRemarks"
        ||(key.indexOf(subjectPrefix)===0&&/\.q[1-3]$|\.final$|\.remarks$/.test(key))){
        field.readOnly=true;
        field.setAttribute("aria-readonly","true");
        field.title="Generated from SF9 Term Grades.";
      }
    });
  }

  function sf10GradeMetadataFields(gradeIndex,profile){
    var base="grade."+(gradeIndex+1)+".";
    var profileFields={
      school:"schoolName",
      schoolId:"schoolId",
      district:"district",
      division:"division",
      region:"region",
      schoolYear:"schoolYear",
      section:"section"
    };
    var fields={};
    Object.keys(profileFields).forEach(function(field){
      var value=profile[profileFields[field]];
      if(value!==undefined&&value!==null&&String(value).trim()){
        fields[base+field]=String(value);
      }
    });
    fields[base+"classifiedGrade"]=String(gradeIndex+1);
    return fields;
  }

  function sf10GradeNumber(value){
    var match=/^(?:grade\s*)?([1-6])$/i.exec(String(value||"").trim());
    return match?Number(match[1]):0;
  }

  function sf10ImportedGradeFields(importData,selectedLrn,currentGrade){
    var normalizeLrn=function(value){return String(value||"").replace(/\D/g,"")};
    var expectedLrn=normalizeLrn(selectedLrn);
    var importedLrn=normalizeLrn(importData&&importData.lrn);
    if(!expectedLrn)throw new Error("Select a learner with an LRN before uploading an SF10 workbook.");
    if(!importedLrn)throw new Error("The uploaded SF10 workbook does not contain an LRN.");
    if(expectedLrn!==importedLrn)throw new Error("The uploaded SF10 LRN does not match the selected learner.");
    var currentGradeNumber=sf10GradeNumber(currentGrade);
    if(!currentGradeNumber)throw new Error("The active class grade could not be determined.");
    if(!importData||!Array.isArray(importData.grades)){
      throw new Error("The SF10 import response did not contain grade records.");
    }

    var fields={};
    var importedGrades=[];
    var metadataMap={
      school:"school",
      schoolId:"schoolId",
      district:"district",
      division:"division",
      region:"region",
      classifiedGrade:"classifiedGrade",
      section:"section",
      schoolYear:"schoolYear",
      adviser:"adviser"
    };
    importData.grades.forEach(function(record){
      var grade=Number(record&&record.grade);
      if(!Number.isInteger(grade)||grade<1||grade>=currentGradeNumber)return;
      var subjects=sf10GradeSubjects[grade-1];
      if(!subjects)return;
      var base="grade."+grade+".";
      subjects.forEach(function(subject,subjectIndex){
        var normalizedSubject=subject.replace(/[^a-zA-Z0-9]/g,"").toLowerCase();
        var importedSubject=(record.subjects||[]).find(function(candidate){
          var normalizedImported=String(candidate&&candidate.name||"")
            .replace(/[^a-zA-Z0-9]/g,"").toLowerCase();
          return normalizedImported&&(normalizedImported===normalizedSubject
            ||normalizedImported.indexOf(normalizedSubject)!==-1
            ||normalizedSubject.indexOf(normalizedImported)!==-1
            ||((normalizedSubject==="epp"||normalizedSubject==="tle")
              &&(normalizedImported==="epp"||normalizedImported==="tle")));
        });
        if(!importedSubject)return;
        if(importedSubject.final!==undefined&&importedSubject.final!==null&&String(importedSubject.final).trim()){
          fields[base+"subjects."+subjectIndex+".final"]=String(importedSubject.final);
        }
        if(importedSubject.remarks!==undefined&&importedSubject.remarks!==null&&String(importedSubject.remarks).trim()){
          fields[base+"subjects."+subjectIndex+".remarks"]=String(importedSubject.remarks);
        }
      });
      Object.keys(metadataMap).forEach(function(sourceKey){
        var value=record[metadataMap[sourceKey]];
        if(value!==undefined&&value!==null&&String(value).trim()){
          fields[base+sourceKey]=String(value);
        }
      });
      if(record.generalAverage!==undefined&&record.generalAverage!==null&&String(record.generalAverage).trim()){
        fields[base+"generalAverage"]=String(record.generalAverage);
      }
      if(Object.keys(fields).some(function(key){return key.indexOf(base)===0})){
        importedGrades.push(grade);
      }
    });
    if(!importedGrades.length)throw new Error("The SF10 workbook has no importable grades below the selected learner's current class grade.");
    return {fields:fields,grades:importedGrades};
  }

  function sf10LoadRecord(recordKey){
    sf10ActiveRecordKey=recordKey||"manual";
    var student=sf10Students.find(function(candidate){return String(candidate.id)===sf10ActiveRecordKey});
    try{
      var records=sf10ReadRecords();
      var record=records[sf10ActiveRecordKey];
      if(record&&record.fields){
        sf10ApplyFields(Object.assign({},student?sf10RosterFields(student):{},record.fields));
        sf10SetStatus("Saved draft loaded from this browser.",false);
      }else{
        sf10ApplyFields(student?sf10RosterFields(student):{});
        sf10SetStatus("No saved draft for this learner yet.",false);
      }
    }catch(error){
      sf10ApplyFields(student?sf10RosterFields(student):{});
      sf10SetStatus("Could not load the saved draft: "+error.message,true);
    }
  }

  async function sf10SyncTermGrades(recordKey){
    var requestId=++sf10GradeSyncRequestId;
    if(!recordKey||recordKey==="manual")return;
    try{
      var profile=await api("/api/teacher/profile");
      if(requestId!==sf10GradeSyncRequestId||sf10ActiveRecordKey!==recordKey)return;
      if(!profile||!profile.grade)throw new Error("The active class grade could not be determined.");
      var classifiedGrades=Array.from({length:sf10GradeSubjects.length},function(_,index){
        var field=$("sf10_grade_"+(index+1)+"_classifiedGrade");
        return field?field.value:"";
      });
      var gradeIndex=sf10ClassifiedGradeIndex(classifiedGrades,profile.grade);
      if(gradeIndex<0){
        throw new Error("Set exactly one SF 10 Classified as Grade field to match "+profile.grade+".");
      }
      sf10LockGradeInputs(gradeIndex,$("sf10Form"));
      var terms=["Term 1","Term 2","Term 3"];
      var termResults=await Promise.all(terms.map(function(term){
        return api("/api/grades?studentId="+encodeURIComponent(recordKey)+"&term="+encodeURIComponent(term));
      }));
      if(requestId!==sf10GradeSyncRequestId||sf10ActiveRecordKey!==recordKey)return;
      var fields=sf10CollectFields();
      Object.assign(fields,sf10TermGradeFields(gradeIndex,termResults,profile.generalAverageSubjects));
      Object.assign(fields,sf10GradeMetadataFields(gradeIndex,profile));
      sf10ApplyFields(fields);
      if(sf10PersistRecord(recordKey)){
        sf10SetStatus("SF9 grades synchronized to "+profile.grade+".",false);
      }
    }catch(error){
      if(requestId===sf10GradeSyncRequestId&&sf10ActiveRecordKey===recordKey){
        sf10SetStatus("Could not synchronize Term Grades: "+error.message,true);
      }
    }
  }

  function sf10SetImportStatus(message,isError){
    var status=$("sf10ImportStatus");
    status.textContent=message||"";
    status.classList.toggle("error",Boolean(isError));
  }

  async function sf10ImportFile(file){
    var recordKey=sf10ActiveRecordKey;
    if(!recordKey||recordKey==="manual"){
      throw new Error("Select a learner from the class roster before uploading an SF10 workbook.");
    }
    var student=sf10Students.find(function(candidate){return String(candidate.id)===recordKey});
    if(!student||!student.lrn){
      throw new Error("The selected roster learner must have an LRN to import an SF10 workbook.");
    }
    var profile=await api("/api/teacher/profile");
    if(sf10ActiveRecordKey!==recordKey)throw new Error("The selected learner changed during import. Try again.");
    var importData=await api("/api/teacher/sf10/import",{
      method:"POST",
      headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
      body:file
    });
    if(sf10ActiveRecordKey!==recordKey)throw new Error("The selected learner changed during import. Try again.");
    var imported=sf10ImportedGradeFields(importData,student.lrn,profile&&profile.grade);
    var existing=sf10CollectFields();
    var fieldsToReplace=Object.keys(imported.fields).filter(function(key){
      return existing[key]!==undefined&&existing[key]!==null&&String(existing[key]).trim()
        &&String(existing[key])!==String(imported.fields[key]);
    });
    var gradeNames=imported.grades.map(function(grade){return "Grade "+grade}).join(", ");
    var message="Import final ratings and school details for "+gradeNames+"? "
      +(fieldsToReplace.length
        ?fieldsToReplace.length+" existing field(s) will be replaced. "
        :"")
      +"Term fields and the current grade will not be changed.";
    if(!window.confirm(message)){
      sf10SetImportStatus("SF10 import cancelled.",false);
      return;
    }
    sf10ApplyFields(Object.assign({},existing,imported.fields));
    if(!sf10PersistRecord(recordKey)){
      sf10ApplyFields(existing);
      throw new Error("The imported fields could not be saved in this browser; the existing draft was restored.");
    }
    sf10SetImportStatus("Imported prior-grade final ratings and school details for "+gradeNames+".",false);
  }

  function selectSf10Page(page,focusTab){
    var showFront=page!=="back";
    $("sf10FrontPage").hidden=!showFront;
    $("sf10BackPage").hidden=showFront;
    $("sf10FrontTab").setAttribute("aria-selected",String(showFront));
    $("sf10BackTab").setAttribute("aria-selected",String(!showFront));
    $("sf10FrontTab").tabIndex=showFront?0:-1;
    $("sf10BackTab").tabIndex=showFront?-1:0;
    if(focusTab)(showFront?$("sf10FrontTab"):$("sf10BackTab")).focus();
  }

  function initializeSf10Form(){
    if(sf10Initialized)return;
    renderSf10GradeCards();
    renderSf10Certifications();
    $("sf10FrontTab").addEventListener("click",function(){selectSf10Page("front",false)});
    $("sf10BackTab").addEventListener("click",function(){selectSf10Page("back",false)});
    $("sf10FrontTab").addEventListener("keydown",function(event){
      if(event.key==="ArrowRight"){event.preventDefault();selectSf10Page("back",true)}
    });
    $("sf10BackTab").addEventListener("keydown",function(event){
      if(event.key==="ArrowLeft"){event.preventDefault();selectSf10Page("front",true)}
    });
    $("sf10Form").addEventListener("input",function(){sf10PersistRecord()});
    $("sf10Form").addEventListener("change",function(){sf10PersistRecord()});
    $("sf10Form").addEventListener("submit",function(event){event.preventDefault();sf10PersistRecord()});
    $("sf10LearnerSelect").addEventListener("change",function(){
      sf10PersistRecord(sf10ActiveRecordKey);
      var recordKey=this.value||"manual";
      sf10LoadRecord(recordKey);
      sf10SyncTermGrades(recordKey);
    });
    $("sf10Form").addEventListener("change",function(event){
      if(event.target.matches('[data-sf10-field$=".classifiedGrade"]')){
        sf10SyncTermGrades(sf10ActiveRecordKey);
      }
    });
    $("sf10Save").addEventListener("click",function(){sf10PersistRecord()});
    $("sf10GradeUploadButton").addEventListener("click",function(){$("sf10GradeUpload").click()});
    $("sf10GradeUpload").addEventListener("change",async function(){
      var file=this.files&&this.files[0];
      this.value="";
      if(!file)return;
      var button=$("sf10GradeUploadButton");
      var learnerSelect=$("sf10LearnerSelect");
      var wasLearnerSelectDisabled=learnerSelect.disabled;
      button.disabled=true;
      learnerSelect.disabled=true;
      sf10SetImportStatus("Reading the SF10 workbook...",false);
      try{
        await sf10ImportFile(file);
      }catch(error){
        sf10SetImportStatus("Could not import SF10 grades: "+error.message,true);
      }finally{
        button.disabled=false;
        learnerSelect.disabled=wasLearnerSelectDisabled;
      }
    });
    $("sf10Print").addEventListener("click",function(){
      sf10PersistRecord();
      document.body.classList.add("sf10-printing");
      window.print();
    });
    window.addEventListener("afterprint",function(){document.body.classList.remove("sf10-printing")});
    selectSf10Page("front",false);
    sf10Initialized=true;
  }

  async function loadSf10Roster(){
    initializeSf10Form();
    var learnerSelect=$("sf10LearnerSelect");
    var selectedKey=learnerSelect.value||sf10ActiveRecordKey||"manual";
    $("sf10RosterNotice").textContent="";
    learnerSelect.disabled=true;
    learnerSelect.replaceChildren(new Option("Enter learner manually","manual"));
    try{
      var result=await api("/api/students");
      if(!Array.isArray(result.students)){
        throw new Error("The roster response did not contain a student list.");
      }
      sf10Students=filterStudentsForActiveSection(result.students);
      sf10Students.forEach(function(student){
        var name=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
        learnerSelect.add(new Option(name+" — "+(student.lrn||"No LRN"),String(student.id)));
      });
      var hasSelected=selectedKey==="manual"||sf10Students.some(function(student){return String(student.id)===selectedKey});
      learnerSelect.value=hasSelected?selectedKey:"manual";
      if(!sf10Students.length){
        $("sf10RosterNotice").textContent="No learners were found in the active class. You can still complete the form manually.";
      }else if(!hasSelected&&selectedKey!=="manual"){
        $("sf10RosterNotice").textContent="The previous learner is not in this class roster. Choose a learner or continue with a manual record.";
      }
      learnerSelect.disabled=false;
      sf10LoadRecord(learnerSelect.value);
      sf10SyncTermGrades(learnerSelect.value);
    }catch(error){
      sf10Students=[];
      learnerSelect.value="manual";
      learnerSelect.disabled=false;
      sf10LoadRecord("manual");
      $("sf10RosterNotice").textContent="Could not load the class roster: "+error.message+" You can still complete the form manually.";
    }
  }

  var initializeDashboard=(function(){
    var initialized=false;
    var requestVersion=0;
    var dashboardNutritionCycle="BOSY";
    var dashboardData={};
    var dashboardErrors={};
    var dashboardPeriods=["BOSY","MOSY","EOSY"];
    var dashboardSourceLabels={
      roster:"student roster",
      attendanceSummary:"attendance summary",
      attendanceMonth:"monthly attendance",
      grades:"grade summary",
      readingBosy:"BOSY reading levels",
      readingMosy:"MOSY reading levels",
      readingEosy:"EOSY reading levels",
      philIri:"Phil-IRI results",
      math:"math assessments",
      profile:"teacher profile",
      calendar:"calendar deadlines",
      mpsYear:"whole-year MPS chart"
    };

    function dashboardSvgEl(name,attrs,text){
      var element=document.createElementNS("http://www.w3.org/2000/svg",name);
      Object.keys(attrs||{}).forEach(function(attribute){
        element.setAttribute(attribute,String(attrs[attribute]));
      });
      if(text!==undefined)element.textContent=String(text);
      return element;
    }

    function dashboardSetLoading(container){
      container.setAttribute("aria-busy","true");
      container.replaceChildren();
      var itemTag=container.tagName==="UL"?"li":"span";
      var first=document.createElement(itemTag);
      first.className="dashboard-skeleton-line";
      first.setAttribute("aria-hidden","true");
      var second=document.createElement(itemTag);
      second.className="dashboard-skeleton-line dashboard-skeleton-short";
      second.setAttribute("aria-hidden","true");
      container.append(first,second);
    }

    function dashboardSetMessage(container,message){
      container.setAttribute("aria-busy","false");
      container.setAttribute("role","img");
      container.setAttribute("aria-label",message);
      container.replaceChildren();
      var text=document.createElement("p");
      text.className="dashboard-chart-message";
      text.textContent=message;
      container.appendChild(text);
    }

    function dashboardSetPanelMessage(container,message,isLoading){
      container.setAttribute("aria-busy",String(Boolean(isLoading)));
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
      container.replaceChildren();
      var text=document.createElement("p");
      text.className="dashboard-chart-message";
      text.textContent=message;
      container.appendChild(text);
    }

    function dashboardSetSvg(container,svg,label){
      svg.setAttribute("role","img");
      svg.setAttribute("aria-label",label);
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
      container.setAttribute("aria-busy","false");
      container.replaceChildren(svg);
    }

    function dashboardHasSource(key){
      if(dashboardData[key]===undefined)return false;
      if(dashboardData[key]===null){
        return true;
      }
      return true;
    }

    function dashboardSourceFailed(key){
      return Object.prototype.hasOwnProperty.call(dashboardErrors,key);
    }

    function dashboardUnavailableMessage(key){
      return dashboardSourceFailed(key)
        ?"Could not load "+dashboardSourceLabels[key]+"."
        :"No "+dashboardSourceLabels[key]+" is available yet.";
    }

    function dashboardRequestIsValid(key,result){
      if(key==="roster"||key==="attendanceSummary"||key==="attendanceMonth"
        ||key==="grades"||key==="readingBosy"||key==="readingMosy"
        ||key==="readingEosy"||key==="philIri"||key==="math"){
        return Boolean(result&&Array.isArray(result.students));
      }
      if(key==="calendar"){
        return Array.isArray(result)||Boolean(result&&(
          Array.isArray(result.events)||Array.isArray(result.tasks)
        ));
      }
      return Boolean(result&&typeof result==="object");
    }

    function dashboardLoadSource(key,url,version){
      return api(url).then(function(result){
        if(version!==requestVersion)return null;
        if(!dashboardRequestIsValid(key,result)){
          dashboardData[key]=null;
          dashboardErrors[key]="The "+dashboardSourceLabels[key]+" response was incomplete.";
          if(key==="roster"){
            dashboardData.mpsYear=null;
            dashboardErrors.mpsYear="The roster is required to calculate MPS.";
          }
        }else{
          dashboardData[key]=result;
          delete dashboardErrors[key];
          if(key==="roster")rosterStudents=result.students;
        }
        renderDashboard();
        if(key==="roster"&&result&&Array.isArray(result.students)){
          return dashboardLoadYearMps(version).then(function(){return result});
        }
        return result;
      },function(error){
        if(version!==requestVersion)return null;
        dashboardData[key]=null;
        dashboardErrors[key]=error&&error.message?error.message:"Request failed.";
        if(key==="roster"){
          dashboardData.mpsYear=null;
          dashboardErrors.mpsYear="The roster is required to calculate MPS.";
        }
        renderDashboard();
        return null;
      });
    }

    function dashboardActiveRoster(){
      if(!Array.isArray(rosterStudents))return [];
      var sectionStudents=!activeStudentSection||activeStudentSection==="__all__"
        ?rosterStudents.slice()
        :filterStudentsForActiveSection(rosterStudents,activeStudentSection);
      return sectionStudents.filter(function(student){return !student.enrollmentStatus});
    }

    function dashboardFilterRows(rows){
      if(!Array.isArray(rows))return [];
      var roster=dashboardActiveRoster();
      if(!activeStudentSection||activeStudentSection==="__all__")return rows;
      var identifiers=new Set();
      roster.forEach(function(student){
        if(student.id!==undefined&&student.id!==null)identifiers.add(String(student.id));
        if(student.lrn)identifiers.add(String(student.lrn));
      });
      return rows.filter(function(row){
        var id=row.id||row.studentId;
        var lrn=row.lrn;
        if(id&&identifiers.has(String(id)))return true;
        if(lrn&&identifiers.has(String(lrn)))return true;
        var section=String(row.section||"");
        return section&&section.toLowerCase()===String(activeStudentSection).toLowerCase();
      });
    }

    function dashboardNumber(value){
      if(value===null||value===undefined||value==="")return null;
      var number=Number(value);
      return Number.isFinite(number)?number:null;
    }

    function dashboardGradeValues(student){
      var terms=student&&student.grades||{};
      var term=terms["Term 1"]||terms.term1||{};
      var average=dashboardNumber(term.generalAverage);
      if(average===null)average=dashboardNumber(term.generalAverageScore);
      if(average!==null)return [average];
      var summary=dashboardData.grades;
      var keys=summary&&Array.isArray(summary.generalAverageSubjects)
        ?summary.generalAverageSubjects.map(function(subject){
          return typeof subject==="string"?subject:subject.key;
        }).filter(Boolean)
        :Object.keys(term);
      return keys.map(function(key){return dashboardNumber(term[key])})
        .filter(function(value){return value!==null&&value>=0&&value<=100});
    }

    function dashboardStudentAverage(student){
      var values=dashboardGradeValues(student);
      if(!values.length)return null;
      return values.reduce(function(total,value){return total+value},0)/values.length;
    }

    function dashboardAverages(rows){
      return rows.map(dashboardStudentAverage).filter(function(value){return value!==null});
    }

    function dashboardSetText(id,text){
      $(id).textContent=text;
    }

    function dashboardPercent(value){
      return value===null||!Number.isFinite(value)?"—":value.toFixed(1)+"%";
    }

    function dashboardRenderHero(){
      var profile=dashboardData.profile;
      var name=(profile&&profile.name)||(currentUser&&currentUser.name)||"Teacher";
      var firstName=String(name).trim().split(/\s+/)[0]||"Teacher";
      var hour=new Date().getHours();
      var greeting=hour<12?"Good morning":hour<18?"Good afternoon":"Good evening";
      var roster=dashboardActiveRoster();
      var section=activeStudentSection&&activeStudentSection!=="__all__"
        ?studentSectionFilterLabel(activeStudentSection)
        :(profile&&profile.section)||"Your classroom";
      var selectedGrade=activeStudentSection&&activeStudentSection!=="__all__"
        &&activeStudentSection!=="__unassigned__"?getSectionGrade(activeStudentSection):"";
      var grade=selectedGrade||(profile&&profile.grade)||defaultStudentGrade||"";
      var subtitle=[section,grade,roster.length+" active "+(roster.length===1?"learner":"learners")]
        .filter(Boolean).join(" · ");
      dashboardSetText("dashboardTitle",greeting+", "+firstName);
      dashboardSetText("dashboardOverviewSubtitle",subtitle);
      dashboardSetText("dashboardHeroSummary",subtitle);
      dashboardSetText("dashboardTeacherInitials",firstName.slice(0,1).toUpperCase()
        +String(name).trim().split(/\s+/).slice(-1)[0].slice(0,1).toUpperCase());
      $("dashboardHero").setAttribute("aria-busy",String(
        !dashboardHasSource("roster")||!dashboardHasSource("profile")
      ));
    }

    function dashboardAttendanceTotals(){
      var totals={Present:0,Tardy:0,Absent:0,Excused:0};
      var source=dashboardData.attendanceMonth;
      if(source&&Array.isArray(source.students)){
        var students=dashboardFilterRows(source.students);
        students.forEach(function(student){
          (student.attendance||[]).forEach(function(status,index){
            if(source.noClassDates&&source.noClassDates.includes(source.dates[index]))return;
            if(status==="Present")totals.Present++;
            else if(status==="Tardy")totals.Tardy++;
            else if(String(status).indexOf("Excused")===0)totals.Excused++;
            else if(status==="Absent"||String(status).indexOf("Absent")===0)totals.Absent++;
          });
        });
        return totals;
      }
      var summary=dashboardData.attendanceSummary;
      if(summary&&Array.isArray(summary.students)){
        var month=dashboardDateKey(new Date()).slice(0,7);
        dashboardFilterRows(summary.students).forEach(function(student){
          var values=student.months&&student.months[month];
          if(!values)return;
          totals.Present+=Number(values.present)||0;
          totals.Absent+=Number(values.absent)||0;
        });
      }
      return totals;
    }

    function dashboardRenderMetrics(){
      var rosterReady=dashboardHasSource("roster")&&dashboardData.roster;
      var roster=dashboardActiveRoster();
      dashboardSetText("dashboardActiveCount",rosterReady?String(roster.length):"—");
      if(rosterReady){
        var genders={male:0,female:0,other:0};
        roster.forEach(function(student){
          var gender=String(student.gender||"").toLowerCase();
          if(gender==="male"||gender==="m")genders.male++;
          else if(gender==="female"||gender==="f")genders.female++;
          else genders.other++;
        });
        dashboardSetText("dashboardGenderSubline",
          genders.male+" male · "+genders.female+" female"+(genders.other?" · "+genders.other+" other":""));
      }else dashboardSetText("dashboardGenderSubline",dashboardData.roster===null
        ?"Could not load roster.":"Loading roster…");

      var totals=dashboardAttendanceTotals();
      var attended=totals.Present+totals.Tardy;
      var recorded=attended+totals.Absent+totals.Excused;
      var attendanceReady=dashboardData.attendanceMonth!==undefined
        &&dashboardData.attendanceSummary!==undefined;
      var attendanceFailed=dashboardData.attendanceMonth===null&&dashboardData.attendanceSummary===null;
      dashboardSetText("dashboardAttendancePercent",attendanceReady&&recorded
        ?Math.round(attended/recorded*100)+"%":"—");
      dashboardSetText("dashboardAttendanceSubline",attendanceFailed
        ?"Could not load attendance."
        :attendanceReady?attended+" present · "+totals.Absent+" absent · "+totals.Tardy+" tardy"
          +(totals.Excused?" · "+totals.Excused+" excused":"")
        :"Loading attendance…");

      var gradeRows=dashboardData.grades&&dashboardData.grades.students
        ?dashboardFilterRows(dashboardData.grades.students):[];
      var gradeAverages=dashboardAverages(gradeRows);
      var classAverage=gradeAverages.length
        ?gradeAverages.reduce(function(total,value){return total+value},0)/gradeAverages.length:null;
      var interpretation=classAverage===null?null:getGradeInterpretation(classAverage);
      dashboardSetText("dashboardAverageGrade",classAverage===null?"—":classAverage.toFixed(1));
      dashboardSetText("dashboardGradeDescriptor",interpretation
        ?interpretation.label+" · Term 1":"Term 1 grades not available");

      var philIri=dashboardData.philIri&&dashboardData.philIri.students
        ?dashboardFilterRows(dashboardData.philIri.students):[];
      var readingPercentages=["English","Filipino"].map(function(language){
        var levels=philIri.map(function(student){
          var languageResult=student.reading&&student.reading[language];
          var data=languageResult&&languageResult.data||{};
          var auto=data.autoScoring||{};
          return String(auto.readingLevel||languageResult&&languageResult.readingLevel||"");
        }).filter(Boolean);
        if(!levels.length)return null;
        var successful=levels.filter(function(level){
          return /instructional|independent/i.test(level);
        }).length;
        return successful/levels.length*100;
      }).filter(function(value){return value!==null});
      var literacyAverage=readingPercentages.length
        ?readingPercentages.reduce(function(total,value){return total+value},0)/readingPercentages.length:null;
      dashboardSetText("dashboardReadingProficiency",dashboardPercent(literacyAverage));
      dashboardSetText("dashboardReadingSubline",dashboardData.philIri===null
        ?"Could not load Phil-IRI results."
        :literacyAverage===null?"No Phil-IRI posttest data yet.":"Average across English and Filipino");

      var math=dashboardData.math;
      var periods=math&&Array.isArray(math.periods)&&math.periods.length?math.periods:dashboardPeriods;
      var mathRows=math&&math.students?dashboardFilterRows(math.students):[];
      var latestPeriod=periods.filter(function(period){
        return mathRows.some(function(student){
          var assessment=student.assessments&&student.assessments[period];
          return assessment&&dashboardNumber(assessment.percentageScore)!==null;
        });
      }).slice(-1)[0];
      var assessed=latestPeriod?mathRows.map(function(student){
        return student.assessments&&student.assessments[latestPeriod];
      }).filter(function(assessment){
        return assessment&&dashboardNumber(assessment.percentageScore)!==null;
      }):[];
      var proficient=assessed.filter(function(assessment){
        return /^(advanced|proficient)/i.test(String(assessment.masteryLevel||""));
      }).length;
      dashboardSetText("dashboardMathMastery",assessed.length
        ?Math.round(proficient/assessed.length*100)+"%":"—");
      dashboardSetText("dashboardMathSubline",dashboardData.math===null
        ?"Could not load RMA results."
        :latestPeriod?latestPeriod+" · proficient or above":"No scored RMA cycle yet");

      var tasks=dashboardUpcomingTasks();
      dashboardSetText("dashboardDeadlineCount",dashboardData.calendar
        ?String(tasks.length):"—");
      dashboardSetText("dashboardDeadlineSubline",dashboardData.calendar===null
        ?"Could not load calendar."
        :tasks.length?"Next: "+dashboardFormatDate(tasks[0].date)
          :dashboardData.calendar===undefined?"Loading calendar…":"No pending deadlines");
    }

    function dashboardRenderLegend(id,items){
      var list=$(id);
      list.replaceChildren();
      items.forEach(function(item){
        var entry=document.createElement("li");
        entry.className="dashboard-legend-item";
        var swatch=document.createElement("span");
        swatch.className="dashboard-legend-swatch";
        swatch.setAttribute("data-series",item.key);
        swatch.setAttribute("aria-hidden","true");
        var text=document.createElement("span");
        text.textContent=item.label+(item.value!==undefined&&item.value!==""?": "+item.value:"");
        entry.append(swatch,text);
        list.appendChild(entry);
      });
    }

    function dashboardRenderGender(){
      var container=$("dashboardGenderChart");
      if(dashboardData.roster===undefined){
        dashboardSetLoading(container);
        return;
      }
      if(dashboardData.roster===null){
        dashboardSetMessage(container,dashboardUnavailableMessage("roster"));
        return;
      }
      var roster=dashboardActiveRoster();
      var counts={Male:0,Female:0,Other:0};
      roster.forEach(function(student){
        var gender=String(student.gender||"").toLowerCase();
        if(gender==="male"||gender==="m")counts.Male++;
        else if(gender==="female"||gender==="f")counts.Female++;
        else counts.Other++;
      });
      var total=roster.length;
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 220 180",class:"dashboard-donut"});
      chart.appendChild(dashboardSvgEl("title",{},"Gender distribution for "+total+" active learners"));
      var radius=65;
      var circumference=2*Math.PI*radius;
      var circle=dashboardSvgEl("circle",{cx:110,cy:84,r:radius,fill:"none",stroke:"var(--line)","stroke-width":22});
      chart.appendChild(circle);
      var offset=0;
      var series=[
        {key:"male",label:"Male",value:counts.Male},
        {key:"female",label:"Female",value:counts.Female},
        {key:"other",label:"Other",value:counts.Other}
      ];
      series.forEach(function(item){
        if(!total||!item.value)return;
        var length=circumference*item.value/total;
        chart.appendChild(dashboardSvgEl("circle",{
          cx:110,cy:84,r:radius,fill:"none",stroke:"var(--accent)",
          "stroke-width":22,"stroke-dasharray":length+" "+(circumference-length),
          "stroke-dashoffset":-offset,transform:"rotate(-90 110 84)",
          class:"dashboard-donut-segment","data-series":item.key
        }));
        offset+=length;
      });
      chart.appendChild(
        dashboardSvgEl("text",{x:110,y:82,"text-anchor":"middle",class:"dashboard-donut-total"},String(total)),
        dashboardSvgEl("text",{x:110,y:103,"text-anchor":"middle",class:"dashboard-donut-caption"},"learners")
      );
      dashboardSetSvg(container,chart,"Gender distribution: "+counts.Male+" male, "+counts.Female
        +" female, "+counts.Other+" other, "+total+" active learners.");
      dashboardRenderLegend("dashboardGenderLegend",series.map(function(item){
        return {key:item.key,label:item.label,value:item.value};
      }));
    }

    function dashboardRenderStackedChart(id,segments,label){
      var container=$(id);
      var total=segments.reduce(function(sum,item){return sum+item.value},0);
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 600 52",class:"dashboard-stacked-chart"});
      chart.appendChild(dashboardSvgEl("title",{},label));
      chart.appendChild(dashboardSvgEl("rect",{x:0,y:8,width:600,height:30,rx:9,fill:"var(--field)"}));
      var x=0;
      segments.forEach(function(item,index){
        if(!total||item.value<=0)return;
        var width=600*item.value/total;
        chart.appendChild(dashboardSvgEl("rect",{
          x:x,y:8,width:width,height:30,rx:index===0||x+width>=600?8:0,
          fill:item.color,class:"dashboard-stack-segment"
        }));
        chart.appendChild(dashboardSvgEl("title",{},item.label+": "+item.value));
        x+=width;
      });
      if(!total)chart.appendChild(dashboardSvgEl("text",{
        x:300,y:29,"text-anchor":"middle",class:"dashboard-chart-axis-label"
      },"No recorded measurements"));
      dashboardSetSvg(container,chart,label+": "+segments.map(function(item){
        return item.label+" "+item.value;
      }).join(", ")+(total?"; "+total+" total":"; no results"));
    }

    function dashboardRenderAttendance(){
      var container=$("dashboardAttendanceStack");
      var hasMonth=dashboardData.attendanceMonth||dashboardData.attendanceSummary;
      if(!hasMonth){
        if(dashboardData.attendanceMonth===undefined||dashboardData.attendanceSummary===undefined){
          dashboardSetLoading(container);
        }else dashboardSetMessage(container,"Could not load monthly attendance.");
        return;
      }
      var totals=dashboardAttendanceTotals();
      var segments=[
        {key:"present",label:"Present",value:totals.Present,color:"var(--accent)"},
        {key:"tardy",label:"Tardy",value:totals.Tardy,color:"color-mix(in srgb,var(--accent) 62%,var(--muted))"},
        {key:"absent",label:"Absent",value:totals.Absent,color:"var(--err)"},
        {key:"excused",label:"Excused",value:totals.Excused,color:"color-mix(in srgb,var(--muted) 55%,var(--field))"}
      ];
      dashboardRenderStackedChart("dashboardAttendanceStack",segments,"Current-month attendance");
      dashboardRenderLegend("dashboardAttendanceLegend",segments.map(function(item){
        return {key:item.key,label:item.label,value:item.value};
      }));
    }

    function dashboardMonthKeys(rows){
      var keys={};
      rows.forEach(function(student){
        Object.keys(student.months||{}).forEach(function(key){
          if(/^\d{4}-\d{2}$/.test(key))keys[key]=true;
        });
      });
      return Object.keys(keys).sort().slice(-6);
    }

    function dashboardRenderAttendanceTrend(){
      var container=$("dashboardAttendanceTrend");
      dashboardRenderLegend("dashboardAttendanceTrendLegend",[]);
      var source=dashboardData.attendanceSummary;
      if(!source){
        if(source===undefined)dashboardSetLoading(container);
        else dashboardSetMessage(container,dashboardUnavailableMessage("attendanceSummary"));
        return;
      }
      var students=dashboardFilterRows(source.students||[]);
      var keys=dashboardMonthKeys(students);
      var points=keys.map(function(key){
        var present=0;
        var absent=0;
        students.forEach(function(student){
          var month=student.months&&student.months[key]||{};
          present+=Number(month.present)||0;
          absent+=Number(month.absent)||0;
        });
        return {key:key,present:present,absent:absent};
      });
      dashboardRenderLegend("dashboardAttendanceTrendLegend",[
        {key:"present",label:"Present"},
        {key:"absent",label:"Absent"}
      ]);
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 640 250",class:"dashboard-chart-svg"});
      chart.appendChild(dashboardSvgEl("title",{},"Present and absent attendance totals by month"));
      if(!points.length){
        chart.appendChild(dashboardSvgEl("text",{x:320,y:125,"text-anchor":"middle"},"No monthly attendance recorded."));
        dashboardSetSvg(container,chart,"Attendance trend: no monthly attendance recorded.");
        return;
      }
      var max=Math.max(1,...points.map(function(point){return point.present+point.absent}));
      var base=195;
      [0,0.5,1].forEach(function(step){
        var y=base-150*step;
        chart.appendChild(dashboardSvgEl("line",{x1:42,y1:y,x2:624,y2:y,stroke:"var(--line)"}));
        chart.appendChild(dashboardSvgEl("text",{x:34,y:y+4,"text-anchor":"end",class:"dashboard-chart-axis-label"},
          String(Math.round(max*step))));
      });
      points.forEach(function(point,index){
        var groupWidth=560/points.length;
        var x=54+groupWidth*index+groupWidth*.18;
        var barWidth=Math.min(25,groupWidth*.25);
        var presentHeight=150*point.present/max;
        var absentHeight=150*point.absent/max;
        var present=dashboardSvgEl("rect",{x:x,y:base-presentHeight,width:barWidth,height:presentHeight,
          rx:4,fill:"var(--accent)"});
        present.appendChild(dashboardSvgEl("title",{},point.key+" present: "+point.present));
        var absent=dashboardSvgEl("rect",{x:x+barWidth+5,y:base-absentHeight,width:barWidth,height:absentHeight,
          rx:4,fill:"var(--err)"});
        absent.appendChild(dashboardSvgEl("title",{},point.key+" absent: "+point.absent));
        chart.append(present,absent);
        chart.appendChild(dashboardSvgEl("text",{x:x+barWidth,y:218,"text-anchor":"middle",class:"dashboard-chart-axis-label"},
          dashboardFormatMonth(point.key)));
      });
      dashboardSetSvg(container,chart,"Attendance trend for the last "+points.length+" recorded months: "
        +points.map(function(point){
          return dashboardFormatMonth(point.key)+" present "+point.present+", absent "+point.absent;
        }).join("; ")+".");
    }

    function dashboardFormatMonth(key){
      var date=new Date(key+"-01T00:00:00");
      return Number.isNaN(date.getTime())?key:date.toLocaleDateString(undefined,{month:"short"});
    }

    function dashboardRenderGradeDistribution(){
      var container=$("dashboardGradeDistribution");
      var summary=dashboardData.grades;
      if(!summary){
        if(dashboardData.grades===undefined)dashboardSetLoading(container);
        else dashboardSetMessage(container,dashboardUnavailableMessage("grades"));
        dashboardSetPanelMessage($("dashboardSubjectAverages"),
          dashboardData.grades===undefined?"Loading subject averages…":dashboardUnavailableMessage("grades"),
          dashboardData.grades===undefined);
        return;
      }
      var gradeRows=dashboardFilterRows(summary.students||[]);
      dashboardRenderSubjectAverages(summary);
      var averages=dashboardAverages(gradeRows);
      var bands=[
        {key:"advancing",label:"Advancing 90+",count:0},
        {key:"benchmarking",label:"Benchmarking 85–89",count:0},
        {key:"connecting",label:"Connecting 80–84",count:0},
        {key:"developing",label:"Developing 75–79",count:0},
        {key:"emerging",label:"Emerging below 75",count:0}
      ];
      averages.forEach(function(value){
        if(value>=90)bands[0].count++;
        else if(value>=85)bands[1].count++;
        else if(value>=80)bands[2].count++;
        else if(value>=75)bands[3].count++;
        else bands[4].count++;
      });
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 680 250",class:"dashboard-chart-svg"});
      chart.appendChild(dashboardSvgEl("title",{},"Term 1 general-average distribution across "+averages.length+" learners"));
      if(!averages.length){
        chart.appendChild(dashboardSvgEl("text",{x:340,y:125,"text-anchor":"middle"},"No Term 1 grades available."));
        dashboardSetSvg(container,chart,"Term 1 grade distribution: no grades available.");
        return;
      }
      var max=Math.max(1,...bands.map(function(band){return band.count}));
      var base=178;
      bands.forEach(function(band,index){
        var x=40+index*128;
        var height=120*band.count/max;
        var rect=dashboardSvgEl("rect",{x:x+12,y:base-height,width:74,height:height,rx:7,
          class:"dashboard-grade-bar","data-grade-band":band.key});
        rect.appendChild(dashboardSvgEl("title",{},band.label+": "+band.count+" learners"));
        chart.appendChild(rect);
        chart.appendChild(dashboardSvgEl("text",{x:x+49,y:base-height-8,"text-anchor":"middle",class:"dashboard-chart-value"},
          String(band.count)));
        chart.appendChild(dashboardSvgEl("text",{x:x+49,y:base+21,"text-anchor":"middle",class:"dashboard-chart-axis-label"},
          ["90+","85–89","80–84","75–79","<75"][index]));
      });
      dashboardSetSvg(container,chart,"Term 1 general-average distribution: "
        +bands.map(function(band){return band.label+" "+band.count}).join(", ")+".");
    }

    function dashboardRenderSubjectAverages(summary){
      var container=$("dashboardSubjectAverages");
      var rows=dashboardFilterRows(summary.students||[]);
      var subjects=Array.isArray(summary.subjects)?summary.subjects:[];
      container.replaceChildren();
      if(!rows.length||!subjects.length){
        container.setAttribute("aria-busy","false");
        var empty=document.createElement("p");
        empty.className="dashboard-chart-message";
        empty.textContent="No subject grades available.";
        container.appendChild(empty);
        return;
      }
      var accessible=[];
      subjects.forEach(function(subject){
        var key=typeof subject==="string"?subject:subject.key;
        var label=typeof subject==="string"?subject:subject.label||subject.key;
        if(!key)return;
        var values=rows.map(function(student){
          return dashboardNumber(student.grades&&student.grades["Term 1"]
            &&student.grades["Term 1"][key]);
        }).filter(function(value){return value!==null&&value>=0&&value<=100});
        if(!values.length)return;
        var average=values.reduce(function(total,value){return total+value},0)/values.length;
        accessible.push(label+" "+average.toFixed(1));
        var row=document.createElement("div");
        row.className="dashboard-subject-row";
        var title=document.createElement("span");
        title.textContent=label;
        var value=document.createElement("strong");
        value.textContent=average.toFixed(1);
        var track=document.createElement("span");
        track.className="dashboard-subject-track";
        var fill=document.createElement("span");
        fill.className="dashboard-subject-fill";
        fill.style.width=Math.max(0,Math.min(100,average))+"%";
        track.appendChild(fill);
        row.append(title,track,value);
        container.appendChild(row);
      });
      container.setAttribute("aria-busy","false");
      container.setAttribute("role","img");
      container.setAttribute("aria-label","Class subject averages: "+accessible.join(", "));
    }

    function dashboardReadingLevel(student,language){
      var levels=student.levels&&student.levels[language];
      if(levels&&typeof levels==="object")return String(levels.readingLevel||levels.level||"");
      return String(levels||"");
    }

    function dashboardRenderReadingGrid(){
      var container=$("dashboardReadingLevels");
      var sources=dashboardPeriods.map(function(period){return dashboardData["reading"+period.charAt(0)+period.slice(1).toLowerCase()]});
      if(sources.every(function(source){return !source})){
        var readingPending=["readingBosy","readingMosy","readingEosy"].some(function(key){
          return dashboardData[key]===undefined;
        });
        if(readingPending)dashboardSetLoading(container);
        else dashboardSetMessage(container,"Could not load reading assessments.");
        return;
      }
      container.replaceChildren();
      ["English","Filipino"].forEach(function(language){
        var languageCard=document.createElement("div");
        languageCard.className="dashboard-reading-language";
        var heading=document.createElement("h3");
        heading.textContent=language;
        var table=document.createElement("table");
        table.className="dashboard-reading-table";
        table.setAttribute("aria-label",language+" reading levels by assessment cycle");
        var thead=document.createElement("thead");
        var headerRow=document.createElement("tr");
        ["Cycle","Non-reader","Frustration","Instructional","Independent"].forEach(function(label){
          var th=document.createElement("th");
          th.scope="col";
          th.textContent=label;
          headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        var tbody=document.createElement("tbody");
        dashboardPeriods.forEach(function(period,index){
          var source=dashboardData["reading"+period.charAt(0)+period.slice(1).toLowerCase()];
          var rows=source&&source.students?dashboardFilterRows(source.students):[];
          var values=rows.map(function(student){return dashboardReadingLevel(student,language)}).filter(Boolean);
          var row=document.createElement("tr");
          var label=document.createElement("th");
          label.scope="row";
          label.textContent=period;
          row.appendChild(label);
          ["Non-reader","Frustration","Instructional","Independent"].forEach(function(level){
            var cell=document.createElement("td");
            cell.setAttribute("data-level",level.toLowerCase().replace(/[^a-z]+/g,"-"));
            cell.textContent=values.length
              ?String(values.filter(function(value){return value.toLowerCase()===level.toLowerCase()}).length)
              :"—";
            row.appendChild(cell);
          });
          tbody.appendChild(row);
        });
        table.append(thead,tbody);
        languageCard.append(heading,table);
        container.appendChild(languageCard);
      });
      container.setAttribute("aria-busy","false");
      container.setAttribute("role","group");
      container.setAttribute("aria-label","Reading levels by cycle for English and Filipino");
    }

    function dashboardRenderRma(){
      var container=$("dashboardRmaTrend");
      var data=dashboardData.math;
      if(!data){
        if(data===undefined){
          dashboardSetText("dashboardRmaLatest","Loading RMA results…");
          dashboardSetLoading(container);
          return;
        }
        dashboardSetText("dashboardRmaLatest",dashboardSourceFailed("math")
          ?"Could not load RMA results.":"Loading RMA results…");
        dashboardSetMessage(container,dashboardSourceFailed("math")
          ?dashboardUnavailableMessage("math"):"Loading RMA trend.");
        return;
      }
      var periods=Array.isArray(data.periods)&&data.periods.length?data.periods:dashboardPeriods;
      var students=dashboardFilterRows(data.students||[]);
      var points=periods.map(function(period){
        var scores=students.map(function(student){
          var assessment=student.assessments&&student.assessments[period];
          return assessment?dashboardNumber(assessment.percentageScore):null;
        }).filter(function(value){return value!==null});
        return {period:period,average:scores.length
          ?scores.reduce(function(total,value){return total+value},0)/scores.length:null};
      });
      var latest=points.slice().reverse().find(function(point){return point.average!==null});
      var bands=Array.isArray(data.masteryBands)?data.masteryBands.slice().sort(function(a,b){
        return Number(b.minimum)-Number(a.minimum);
      }):[];
      var descriptor=latest&&bands.find(function(band){return latest.average>=Number(band.minimum)});
      dashboardSetText("dashboardRmaLatest",latest
        ?"Latest: "+latest.average.toFixed(1)+"% — "+(descriptor?descriptor.level:"Class average")
        :"No scored learners in the available cycles.");
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 640 245",class:"dashboard-chart-svg"});
      chart.appendChild(dashboardSvgEl("title",{},"Average RMA percentage by cycle"));
      [0,25,50,75,100].forEach(function(value){
        var y=190-150*value/100;
        chart.append(
          dashboardSvgEl("line",{x1:52,y1:y,x2:620,y2:y,stroke:"var(--line)"}),
          dashboardSvgEl("text",{x:43,y:y+4,"text-anchor":"end",class:"dashboard-chart-axis-label"},String(value))
        );
      });
      var plotted=points.map(function(point,index){
        return {point:point,x:72+(520*index/Math.max(1,points.length-1)),
          y:point.average===null?null:190-150*point.average/100};
      });
      for(var index=1;index<plotted.length;index++){
        if(plotted[index-1].y===null||plotted[index].y===null)continue;
        chart.appendChild(dashboardSvgEl("line",{x1:plotted[index-1].x,y1:plotted[index-1].y,
          x2:plotted[index].x,y2:plotted[index].y,stroke:"var(--accent)","stroke-width":4,
          "stroke-linecap":"round"}));
      }
      plotted.forEach(function(item){
        if(item.y!==null){
          var point=dashboardSvgEl("circle",{cx:item.x,cy:item.y,r:6,fill:"var(--accent)"});
          point.appendChild(dashboardSvgEl("title",{},item.point.period+": "+item.point.average.toFixed(1)+"%"));
          chart.appendChild(point);
        }
        chart.appendChild(dashboardSvgEl("text",{x:item.x,y:218,"text-anchor":"middle",class:"dashboard-chart-axis-label"},
          item.point.period));
      });
      if(!latest)chart.appendChild(dashboardSvgEl("text",{x:320,y:115,"text-anchor":"middle"},"No scored learners."));
      dashboardSetSvg(container,chart,"RMA class average by cycle: "
        +points.map(function(point){return point.period+" "+(point.average===null?"no data":point.average.toFixed(1)+" percent")}).join(", ")+".");
    }

    function dashboardRenderNutrition(){
      var roster=dashboardActiveRoster();
      if(dashboardData.roster===undefined){
        dashboardSetLoading($("dashboardBmiBar"));
        dashboardSetLoading($("dashboardHeightBar"));
        dashboardSetText("dashboardNutritionCycleSummary","Loading nutritional assessments…");
        return;
      }
      if(dashboardData.roster===null){
        dashboardSetMessage($("dashboardBmiBar"),dashboardUnavailableMessage("roster"));
        dashboardSetMessage($("dashboardHeightBar"),dashboardUnavailableMessage("roster"));
        dashboardSetText("dashboardNutritionCycleSummary",dashboardUnavailableMessage("roster"));
        return;
      }
      var measured=roster.map(function(student){
        return nutritionalAssessmentForStudent(student,dashboardNutritionCycle);
      }).filter(function(assessment){
        return Boolean(assessment.measurementDate);
      });
      var assessedCount=measured.length;
      dashboardSetText("dashboardNutritionCycleSummary",
        dashboardNutritionCycle+" · "+assessedCount+" of "+roster.length+" learners assessed.");
      dashboardSetText("dashboardBmiHeading",dashboardNutritionCycle+" BMI-for-age");
      dashboardSetText("dashboardHeightHeading",dashboardNutritionCycle+" height-for-age");
      var bmiCategories=["Normal","Wasted","Severely Wasted","Overweight","Obese"];
      var bmiColors=["var(--accent)","color-mix(in srgb,var(--accent) 68%,var(--muted))","var(--err)",
        "color-mix(in srgb,var(--muted) 55%,var(--field))","color-mix(in srgb,var(--err) 55%,var(--muted))"];
      var bmiValues=bmiCategories.map(function(category){
        return {key:category.toLowerCase().replace(/\s+/g,"-"),label:category,
          value:measured.filter(function(assessment){
            return String(assessment.bmiCategory||"").toLowerCase()===category.toLowerCase();
          }).length,color:bmiColors[bmiCategories.indexOf(category)]};
      });
      if(assessedCount){
        dashboardRenderStackedChart("dashboardBmiBar",bmiValues,"BMI-for-age distribution");
        dashboardRenderLegend("dashboardBmiLegend",bmiValues.map(function(item){
          return {key:item.key,label:item.label,value:item.value};
        }));
      }else{
        dashboardSetMessage($("dashboardBmiBar"),"No "+dashboardNutritionCycle+" measurements recorded yet.");
        dashboardRenderLegend("dashboardBmiLegend",[]);
      }
      var heightCategories=["Normal","Stunted","Severely Stunted"];
      var heightColors=["var(--accent)","color-mix(in srgb,var(--accent) 58%,var(--muted))","var(--err)"];
      var heightValues=heightCategories.map(function(category){
        return {key:category.toLowerCase().replace(/\s+/g,"-"),label:category,
          value:measured.filter(function(assessment){
            return String(assessment.heightForAgeStatus||assessment.hfaCategory||"").toLowerCase()===category.toLowerCase();
          }).length,color:heightColors[heightCategories.indexOf(category)]};
      });
      if(assessedCount){
        dashboardRenderStackedChart("dashboardHeightBar",heightValues,"Height-for-age distribution");
        dashboardRenderLegend("dashboardHeightLegend",heightValues.map(function(item){
          return {key:item.key,label:item.label,value:item.value};
        }));
      }else{
        dashboardSetMessage($("dashboardHeightBar"),"No "+dashboardNutritionCycle+" measurements recorded yet.");
        dashboardRenderLegend("dashboardHeightLegend",[]);
      }
    }

    function dashboardTaskList(){
      var source=dashboardData.calendar;
      if(Array.isArray(source))return source;
      if(source&&Array.isArray(source.events))return source.events;
      if(source&&Array.isArray(source.tasks))return source.tasks;
      return [];
    }

    function dashboardTaskDate(task){
      var value=task.dueDate||task.date||task.deadline||"";
      return String(value).slice(0,10);
    }

    function dashboardParseDate(value){
      if(!value)return null;
      var text=String(value).slice(0,10);
      var date=new Date(text+"T00:00:00");
      return Number.isNaN(date.getTime())?null:date;
    }

    function dashboardDateKey(date){
      var year=date.getFullYear();
      var month=String(date.getMonth()+1).padStart(2,"0");
      var day=String(date.getDate()).padStart(2,"0");
      return year+"-"+month+"-"+day;
    }

    function dashboardFormatDate(value){
      var date=dashboardParseDate(value);
      return date?date.toLocaleDateString(undefined,{month:"short",day:"numeric"}):"Date not set";
    }

    function dashboardUpcomingTasks(){
      return dashboardTaskList().map(function(task){
        var date=dashboardTaskDate(task);
        var due=dashboardParseDate(date);
        var status=String(task.status||"").toLowerCase();
        var complete=task.completed===true||task.isDone===true||status==="done"||status==="completed";
        return {task:task,date:date,due:due,complete:complete};
      }).filter(function(item){
        return !item.complete&&item.due;
      }).sort(function(first,second){return first.date.localeCompare(second.date)});
    }

    function dashboardRenderDeadlines(){
      var list=$("dashboardDeadlineList");
      var empty=$("dashboardDeadlineEmpty");
      list.replaceChildren();
      empty.hidden=true;
      if(dashboardData.calendar===undefined){
        dashboardSetLoading(list);
        empty.hidden=false;
        empty.textContent="Loading calendar deadlines…";
        return;
      }
      if(dashboardData.calendar===null){
        list.setAttribute("aria-busy","false");
        empty.hidden=false;
        empty.textContent=dashboardUnavailableMessage("calendar");
        return;
      }
      list.setAttribute("aria-busy","false");
      var upcoming=dashboardUpcomingTasks();
      if(!upcoming.length){
        empty.hidden=false;
        empty.textContent="No upcoming deadlines.";
        return;
      }
      upcoming.slice(0,3).forEach(function(item){
        var entry=document.createElement("li");
        var today=dashboardParseDate(dashboardDateKey(new Date()));
        var days=Math.round((item.due.getTime()-today.getTime())/86400000);
        entry.className="dashboard-deadline-item";
        entry.setAttribute("data-urgency",days<=1?"urgent":days<=3?"soon":"later");
        var title=document.createElement("strong");
        title.textContent=String(item.task.title||item.task.task||"Untitled task");
        var details=document.createElement("span");
        details.textContent=dashboardFormatDate(item.date)+" · "+(days<0
          ?"Overdue by "+Math.abs(days)+" "+(Math.abs(days)===1?"day":"days")
          :days===0?"Due today":days===1?"1 day left":days+" days left");
        entry.append(title,details);
        list.appendChild(entry);
      });
    }

    async function dashboardLoadYearMps(version){
      var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
        ?activeStudentSection:defaultStudentSection;
      var selectedType=$("mpsSummaryTestType").value;
      var scoreIndex={ST1:8,ST2:9,TE:10}[selectedType];
      if(!reportSection||reportSection==="__unassigned__"||scoreIndex===undefined){
        dashboardData.mpsYear={terms:["Term 1","Term 2","Term 3"],subjects:[],assessmentType:selectedType};
        delete dashboardErrors.mpsYear;
        renderDashboard();
        return;
      }
      var available=eClassSubjectOptions.length
        ?eClassSubjectOptions.slice()
        :getTeacherSubjectsForSection(reportSection).slice();
      if(!available.length)available=availableSubjects.slice();
      var uniqueSubjects=[];
      var seenSubjects=Object.create(null);
      available.forEach(function(subject){
        var canonical=mpsEclassSubjectValue(subject);
        var key=canonical.toLowerCase();
        if(!canonical||seenSubjects[key])return;
        seenSubjects[key]=true;
        uniqueSubjects.push({key:canonical,label:mpsSummarySubjectLabel(canonical)});
      });
      if(!uniqueSubjects.length){
        dashboardData.mpsYear={terms:["Term 1","Term 2","Term 3"],subjects:[],assessmentType:selectedType};
        delete dashboardErrors.mpsYear;
        renderDashboard();
        return;
      }
      dashboardData.mpsYear={loading:true,terms:["Term 1","Term 2","Term 3"],
        subjects:uniqueSubjects,assessmentType:selectedType};
      delete dashboardErrors.mpsYear;
      renderDashboard();
      var students=filterStudentsForActiveSection(rosterStudents,reportSection);
      var terms=dashboardData.mpsYear.terms;

      async function getRecord(term,subject,mapehGroup){
        var query="?term="+encodeURIComponent(term)
          +"&subject="+encodeURIComponent(subject)
          +"&mapehGroup="+encodeURIComponent(mapehGroup||"")
          +"&section="+encodeURIComponent(reportSection);
        return api("/api/e-class/record"+query);
      }

      function validScore(value,totalItems){
        var score=typeof value==="string"&&value.trim()!==""?Number(value):NaN;
        return Number.isFinite(score)&&score>=0&&score<=totalItems?score:NaN;
      }

      async function loadSubjectTerm(subject,term){
        try{
          var scoreTotal=0;
          var learnerCount=0;
          var totalItems=0;
          if(subject.key==="MAPEH"){
            var groupRecords=await Promise.all(["Music and Arts","PE and Health"].map(function(group){
              return getRecord(term,subject.key,group);
            }));
            if(groupRecords.some(function(record){return !record.saved}))return{mps:null};
            var groupItemTotals=groupRecords.map(function(record){
              return record.highestScores&&Number(record.highestScores[scoreIndex]);
            });
            if(groupItemTotals.some(function(total){return !Number.isInteger(total)||total<=0})){
              return{mps:null};
            }
            totalItems=groupItemTotals.reduce(function(total,value){return total+value},0);
            var groupScores=groupRecords.map(function(record){
              return record.scores&&typeof record.scores==="object"?record.scores:{};
            });
            students.forEach(function(student){
              var scores=groupScores.map(function(records){return records[student.id]});
              var rawScores=scores.map(function(values,index){
                return validScore(Array.isArray(values)?values[scoreIndex]:"",groupItemTotals[index]);
              });
              if(rawScores.every(Number.isFinite)){
                scoreTotal+=rawScores.reduce(function(total,value){return total+value},0);
                learnerCount++;
              }
            });
          }else{
            var record=await getRecord(term,subject.key);
            if(!record.saved)return{mps:null};
            totalItems=record.highestScores&&Number(record.highestScores[scoreIndex]);
            if(!Number.isInteger(totalItems)||totalItems<=0)return{mps:null};
            var scores=record.scores&&typeof record.scores==="object"?record.scores:{};
            students.forEach(function(student){
              var values=scores[student.id];
              var score=validScore(Array.isArray(values)?values[scoreIndex]:"",totalItems);
              if(Number.isFinite(score)){
                scoreTotal+=score;
                learnerCount++;
              }
            });
          }
          return{mps:learnerCount?scoreTotal/learnerCount/totalItems*100:null,learnerCount:learnerCount};
        }catch(error){
          return{mps:null,error:error&&error.message?error.message:"Request failed."};
        }
      }

      var termResults=await Promise.all(terms.map(function(term){
        return Promise.all(uniqueSubjects.map(function(subject){
          return loadSubjectTerm(subject,term);
        }));
      }));
      if(version!==requestVersion)return;
      var failures=[];
      var subjects=uniqueSubjects.map(function(subject,subjectIndex){
        var values={};
        terms.forEach(function(term,termIndex){
          var result=termResults[termIndex][subjectIndex];
          values[term]={mps:result.mps,learnerCount:result.learnerCount||0};
          if(result.error)failures.push(subject.label+" ("+term+"): "+result.error);
        });
        return {key:subject.key,label:subject.label,values:values};
      });
      dashboardData.mpsYear={terms:terms,subjects:subjects,assessmentType:selectedType};
      if(failures.length){
        dashboardErrors.mpsYear=failures.length===terms.length*uniqueSubjects.length
          ?"Could not load whole-year MPS results."
          :"Some subject and term MPS results could not be loaded.";
      }else delete dashboardErrors.mpsYear;
      renderDashboard();
    }

    function dashboardRenderYearMps(){
      var container=$("dashboardMpsYearChart");
      var notice=$("dashboardMpsYearNotice");
      var data=dashboardData.mpsYear;
      notice.classList.remove("error");
      if(data===undefined||data&&data.loading){
        dashboardSetLoading(container);
        dashboardSetText("dashboardMpsYearSubtitle","Loading Term 1–3 E-Class results…");
        notice.textContent="";
        return;
      }
      if(data===null){
        dashboardSetMessage(container,"Could not load the year MPS results.");
        dashboardSetText("dashboardMpsYearSubtitle","Term 1, Term 2, and Term 3");
        notice.textContent="The roster or E-Class data could not be loaded.";
        notice.classList.add("error");
        return;
      }
      var typeLabels={ST1:"Summative Test 1",ST2:"Summative Test 2",TE:"Term Examination"};
      var typeLabel=typeLabels[data.assessmentType]||data.assessmentType||"E-Class";
      dashboardSetText("dashboardMpsYearSubtitle","Term 1–3 · "+typeLabel+" · Mean Percentage Score");
      dashboardRenderLegend("dashboardMpsYearLegend",data.terms.map(function(term,index){
        return {key:"term-"+(index+1),label:term,value:""};
      }));
      var subjects=data.subjects||[];
      var hasScores=subjects.some(function(subject){
        return data.terms.some(function(term){
          return subject.values&&dashboardNumber(subject.values[term]&&subject.values[term].mps)!==null;
        });
      });
      if(!subjects.length||!hasScores){
        dashboardSetMessage(container,subjects.length
          ?"No saved Term 1–3 "+typeLabel+" scores are available for this section."
          :"No subjects are configured for this section.");
        notice.textContent="";
        return;
      }
      var left=212;
      var plotWidth=485;
      var rowTop=48;
      var rowHeight=75;
      var height=rowTop+subjects.length*rowHeight+24;
      var chart=dashboardSvgEl("svg",{viewBox:"0 0 760 "+height,class:"dashboard-mps-chart"});
      chart.appendChild(dashboardSvgEl("title",{},"Whole-year mean percentage score by subject for "+typeLabel));
      [0,25,50,75,100].forEach(function(value){
        var x=left+plotWidth*value/100;
        chart.append(
          dashboardSvgEl("line",{x1:x,y1:30,x2:x,y2:height-18,class:"dashboard-mps-gridline"}),
          dashboardSvgEl("text",{x:x,y:20,"text-anchor":"middle"},value+"%")
        );
      });
      subjects.forEach(function(subject,subjectIndex){
        var y=rowTop+subjectIndex*rowHeight;
        chart.appendChild(dashboardSvgEl("text",{x:left-13,y:y+27,"text-anchor":"end",
          class:"dashboard-mps-subject"},subject.label));
        data.terms.forEach(function(term,termIndex){
          var result=subject.values&&subject.values[term]||{};
          var value=dashboardNumber(result.mps);
          var barY=y+termIndex*18;
          if(value===null){
            chart.appendChild(dashboardSvgEl("text",{x:left+5,y:barY+11},"—"));
            return;
          }
          var width=plotWidth*Math.max(0,Math.min(100,value))/100;
          var bar=dashboardSvgEl("rect",{x:left,y:barY,width:width,height:12,rx:4,
            class:"dashboard-mps-bar","data-series":"term-"+(termIndex+1)});
          bar.appendChild(dashboardSvgEl("title",{},subject.label+" · "+term+": "+value.toFixed(2)
            +"% MPS · "+(result.learnerCount||0)+" learners"));
          chart.appendChild(bar);
          chart.appendChild(dashboardSvgEl("text",{x:left+width+6,y:barY+10,class:"dashboard-mps-value"},
            value.toFixed(1)+"%"));
        });
      });
      var accessibleValues=[];
      subjects.forEach(function(subject){
        data.terms.forEach(function(term){
          var result=subject.values&&subject.values[term]||{};
          var value=dashboardNumber(result.mps);
          accessibleValues.push(subject.label+" "+term+" "+(value===null?"no data":value.toFixed(1)+" percent"));
        });
      });
      dashboardSetSvg(container,chart,"Whole-year MPS by subject for "+typeLabel+": "
        +accessibleValues.join("; ")+".");
      if(dashboardErrors.mpsYear){
        notice.textContent="Some subject-term results could not be loaded; available MPS values are shown.";
        notice.classList.add("error");
      }else notice.textContent="";
    }

    function renderDashboard(){
      dashboardRenderHero();
      dashboardRenderMetrics();
      dashboardRenderGender();
      dashboardRenderAttendance();
      dashboardRenderAttendanceTrend();
      dashboardRenderGradeDistribution();
      dashboardRenderReadingGrid();
      dashboardRenderRma();
      dashboardRenderNutrition();
      dashboardRenderDeadlines();
      dashboardRenderYearMps();
      var hasMpsError=Object.prototype.hasOwnProperty.call(dashboardErrors,"mpsYear");
      var unavailable=Object.keys(dashboardErrors)
        .filter(function(key){return key!=="mpsYear"})
        .map(function(key){return dashboardSourceLabels[key]});
      var notice=$("dashboardNotice");
      notice.textContent=unavailable.length
        ?"Some dashboard sections could not load: "+unavailable.join(", ")+". Refresh to try again."
        :hasMpsError?"":"Dashboard reflects the currently selected class section.";
      notice.classList.toggle("error",unavailable.length>0);
    }

    function dashboardShowInitialLoading(){
      [
        "dashboardGenderChart","dashboardAttendanceStack","dashboardAttendanceTrend",
        "dashboardGradeDistribution","dashboardReadingLevels","dashboardRmaTrend",
        "dashboardBmiBar","dashboardHeightBar","dashboardSubjectAverages",
        "dashboardDeadlineList","dashboardMpsYearChart"
      ].forEach(function(id){dashboardSetLoading($(id))});
      ["dashboardActiveCount","dashboardAttendancePercent","dashboardAverageGrade",
        "dashboardReadingProficiency","dashboardMathMastery","dashboardDeadlineCount"]
        .forEach(function(id){dashboardSetText(id,"…")});
      dashboardSetText("dashboardGenderSubline","Loading roster…");
      dashboardSetText("dashboardAttendanceSubline","Loading attendance…");
      dashboardSetText("dashboardGradeDescriptor","Loading grade summary…");
      dashboardSetText("dashboardReadingSubline","Loading reading results…");
      dashboardSetText("dashboardMathSubline","Loading RMA results…");
      dashboardSetText("dashboardDeadlineSubline","Loading calendar…");
      dashboardSetText("dashboardNutritionCycleSummary","Loading nutritional assessments…");
      dashboardSetText("dashboardMpsYearSubtitle","Loading Term 1–3 E-Class results…");
      dashboardSetText("dashboardMpsYearNotice","");
      $("dashboardMpsYearNotice").classList.remove("error");
      $("dashboardHero").setAttribute("aria-busy","true");
      $("dashboardNotice").textContent="Loading classroom data…";
      $("dashboardNotice").classList.remove("error");
    }

    function refreshDashboardData(){
      var version=++requestVersion;
      var now=new Date();
      var month=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
      var from=new Date(now.getFullYear(),now.getMonth(),now.getDate()-30);
      var to=new Date(now.getFullYear(),now.getMonth(),now.getDate()+90);
      var urls={
        roster:"/api/students",
        attendanceSummary:"/api/attendance/summary",
        attendanceMonth:"/api/attendance/month?month="+encodeURIComponent(month),
        grades:"/api/grades/summary",
        readingBosy:"/api/reading-assessments?period=BOSY",
        readingMosy:"/api/reading-assessments?period=MOSY",
        readingEosy:"/api/reading-assessments?period=EOSY",
        philIri:"/api/phil-iri/assessments?period=BOSY&assessmentType=Posttest",
        math:"/api/math-assessments",
        profile:"/api/teacher/profile",
        calendar:"/api/teacher-calendar/events?from="+encodeURIComponent(dashboardDateKey(from))
          +"&to="+encodeURIComponent(dashboardDateKey(to))
      };
      dashboardData={};
      dashboardErrors={};
      dashboardShowInitialLoading();
      $("dashboardRefresh").disabled=true;
      var requests=Object.keys(urls).map(function(key){
        return dashboardLoadSource(key,urls[key],version);
      });
      return Promise.all(requests).then(function(){
        if(version===requestVersion)$("dashboardRefresh").disabled=false;
      });
    }

    function applyDashboardDisplayFilter(){
      var category=$("dashboardDisplayFilter").value;
      Array.prototype.forEach.call(document.querySelectorAll("#dashboardPage [data-dashboard-category]"),function(item){
        var categories=item.getAttribute("data-dashboard-category").split(/\s+/);
        item.hidden=category!=="all"&&categories.indexOf(category)===-1;
      });
      $("dashboardMetricGrid").hidden=!$("dashboardMetricGrid").querySelector("[data-dashboard-category]:not([hidden])");
      $("dashboardMpsDeadlineRow").hidden=!$("dashboardMpsDeadlineRow").querySelector("[data-dashboard-category]:not([hidden])");
    }

    function initializeDashboard(){
      if(!initialized){
        $("dashboardDisplayFilter").addEventListener("change",applyDashboardDisplayFilter);
        $("dashboardNutritionBosyTab").addEventListener("click",function(){
          dashboardNutritionCycle="BOSY";
          $("dashboardNutritionBosyTab").setAttribute("aria-selected","true");
          $("dashboardNutritionEosyTab").setAttribute("aria-selected","false");
          $("dashboardNutritionBosyTab").tabIndex=0;
          $("dashboardNutritionEosyTab").tabIndex=-1;
          dashboardRenderNutrition();
        });
        $("dashboardNutritionEosyTab").addEventListener("click",function(){
          dashboardNutritionCycle="EOSY";
          $("dashboardNutritionBosyTab").setAttribute("aria-selected","false");
          $("dashboardNutritionEosyTab").setAttribute("aria-selected","true");
          $("dashboardNutritionBosyTab").tabIndex=-1;
          $("dashboardNutritionEosyTab").tabIndex=0;
          dashboardRenderNutrition();
        });
        $("dashboardNutritionBosyTab").addEventListener("keydown",function(event){
          if(event.key==="ArrowRight"){
            event.preventDefault();
            $("dashboardNutritionEosyTab").focus();
            $("dashboardNutritionEosyTab").click();
          }
        });
        $("dashboardNutritionEosyTab").addEventListener("keydown",function(event){
          if(event.key==="ArrowLeft"){
            event.preventDefault();
            $("dashboardNutritionBosyTab").focus();
            $("dashboardNutritionBosyTab").click();
          }
        });
        applyDashboardDisplayFilter();
        $("dashboardRefresh").addEventListener("click",refreshDashboardData);
        $("dashboardPendingMetric").addEventListener("click",function(){showDashboardPage("tools");setActiveToolPanel("calendarPanel")});
        $("dashboardOpenNutrition").addEventListener("click",function(){showDashboardPage("nutritionalStatus")});
        $("dashboardOpenMpsSummary").addEventListener("click",function(){showDashboardPage("assessmentMpsSummary")});
        initialized=true;
      }
      return refreshDashboardData();
    }

    return initializeDashboard;
  })();

  function loadDashboardOverview(){
    initializeDashboard();
  }

  function setActiveToolPanel(panelId){
    var selector=$("toolsSelector");
    selector.value=panelId;
    selector.dispatchEvent(new Event("change",{bubbles:true}));
  }

  function showDashboardPage(page){
    if((page==="assessmentDifficultyIndex"||page==="assessmentItemAnalysis"||page==="assessmentLeastMastered")
      &&(!currentUser||!currentUser.isAdmin)){
      page="students";
    }
    var showReading=page==="reading";
    var showPhilIri=page==="philIri";
    var showAssessmentMps=page==="assessmentMps";
    var showAssessmentMpsSummary=page==="assessmentMpsSummary";
    var showAssessmentDifficultyIndex=page==="assessmentDifficultyIndex";
    var showAssessmentItemAnalysis=page==="assessmentItemAnalysis";
    var showAssessmentLeastMastered=page==="assessmentLeastMastered";
    var showRma=page==="rma";
    var showNutritionalStatus=page==="nutritionalStatus";
    var showEClass=page==="eClass";
    var showSf10=page==="sf10";
    if(showReading&&(!currentUser||!currentUser.isAdmin))return;
    var leavingReading=!$("readingProgressPage").hidden&&!showReading;
    var leavingRma=!$("rmaPage").hidden&&!showRma;
    var leavingEClass=!$("eClassPage").hidden&&!showEClass;
    var showDashboard=page==="dashboard";
    var showAttendance=page==="attendance";
    var leavingAttendance=!$("attendancePage").hidden&&!showAttendance;
    var leavingProfile=!$("teacherProfilePage").hidden&&page!=="profile";
    var showSettings=page==="settings";
    var showTools=page==="tools";
    if((leavingReading&&readingDirty||leavingRma&&rmaDirty||leavingAttendance&&attendanceDirty
      ||leavingProfile&&(teacherProfileDirty||teacherPasswordDirty))
      &&!window.confirm("Discard unsaved changes?"))return;
    if(leavingEClass&&eClassDirty
      &&!window.confirm("Leave E-Class with unsaved changes? Your draft remains in this browser, but it will not be saved to the backend until you select Save & Lock Record."))return;
    if((page==="reading"&&!$("readingProgressPage").hidden)
      ||(showRma&&!$("rmaPage").hidden)
      ||(showAssessmentMps&&!$("assessmentMpsPage").hidden)
      ||(showAssessmentMpsSummary&&!$("assessmentMpsSummaryPage").hidden)
      ||(showNutritionalStatus&&!$("nutritionalStatusPage").hidden)
      ||(showAttendance&&!$("attendancePage").hidden)
      ||(showEClass&&!$("eClassPage").hidden)
      ||(showSf10&&!$("sf10Page").hidden)
      ||(page==="profile"&&!$("teacherProfilePage").hidden)
      ||(showSettings&&!$("settingsPage").hidden)
      ||(showTools&&!$("toolsPage").hidden))return;
    refreshAttendanceYears();
    var showGrades=page==="grades";
    var showSummary=page==="summary";
    if(!showReading)readingDirty=false;
    if(!showRma)rmaDirty=false;
    if(!showAttendance)attendanceDirty=false;
    if(page!=="profile"){
      teacherProfileDirty=false;
      teacherProfileDetailsDirty=false;
      teacherProfileBasicDirty=false;
      teacherProfileSchoolDirty=false;
      teacherSubjectsDirty=false;
      teacherPasswordDirty=false;
      $("teacherPasswordForm").reset();
    }
    $("dashboardPage").hidden=!showDashboard;
    $("studentsPage").hidden=showDashboard||showAttendance||showEClass||showGrades||showSf10||showSummary||showReading||showPhilIri||showAssessmentMps||showAssessmentMpsSummary||showAssessmentDifficultyIndex||showAssessmentItemAnalysis||showAssessmentLeastMastered||showRma||showNutritionalStatus||page==="profile"||showSettings||showTools;
    $("nutritionalStatusPage").hidden=!showNutritionalStatus;
    $("attendancePage").hidden=!showAttendance;
    $("eClassPage").hidden=!showEClass;
    $("termGradesPage").hidden=!showGrades;
    $("sf10Page").hidden=!showSf10;
    $("gradeSummaryPage").hidden=!showSummary;
    $("assessmentMpsPage").hidden=!showAssessmentMps;
    $("assessmentMpsSummaryPage").hidden=!showAssessmentMpsSummary;
    $("assessmentDifficultyIndexPage").hidden=!showAssessmentDifficultyIndex;
    $("assessmentItemAnalysisPage").hidden=!showAssessmentItemAnalysis;
    $("assessmentLeastMasteredPage").hidden=!showAssessmentLeastMastered;
    $("philIriPage").hidden=!showPhilIri;
    $("readingProgressPage").hidden=!showReading;
    $("rmaPage").hidden=!showRma;
    var showProfile=page==="profile";
    $("teacherProfilePage").hidden=!showProfile;
    $("settingsPage").hidden=!showSettings;
    $("toolsPage").hidden=!showTools;
    [["navDashboard",showDashboard],["navStudents",!showDashboard&&!showAttendance&&!showEClass&&!showGrades&&!showSf10&&!showSummary&&!showReading&&!showPhilIri&&!showAssessmentMps&&!showAssessmentMpsSummary&&!showAssessmentDifficultyIndex&&!showAssessmentItemAnalysis&&!showAssessmentLeastMastered&&!showRma&&!showNutritionalStatus&&!showProfile&&!showSettings&&!showTools],["navAttendance",showAttendance],["navEClass",showEClass],["navTermGrades",showGrades],["navSf10",showSf10],["navGradeSummary",showSummary],["navAssessmentMps",showAssessmentMps],["navAssessmentMpsSummary",showAssessmentMpsSummary],["navAssessmentDifficultyIndex",showAssessmentDifficultyIndex],["navAssessmentItemAnalysis",showAssessmentItemAnalysis],["navAssessmentLeastMastered",showAssessmentLeastMastered],["navPhilIri",showPhilIri],["navRma",showRma],["navNutritionalStatus",showNutritionalStatus],["navTeacherProfile",showProfile],["navSettings",showSettings],["navTools",showTools]]
      .forEach(function(entry){
        if(entry[1])$(entry[0]).setAttribute("aria-current","page");
        else $(entry[0]).removeAttribute("aria-current");
      });
    closeSidebar();
    $("workspace").scrollTop=0;
    if(showProfile)$("teacherProfilePage").scrollTop=0;
    if(showSettings)$("settingsPage").scrollTop=0;
    var pageLabels={
      dashboard:["GraceDesk","Dashboard"],
      students:["GraceDesk","Classroom dashboard"],
      attendance:["GraceDesk","Attendance"],
      eClass:["GraceDesk","E-Class"],
      grades:["GraceDesk","Term Grade (SF9)"],
      sf10:["GraceDesk","SF 10"],
      summary:["GraceDesk","Summary of Grades"],
      assessmentMps:["GraceDesk","Assessment Dashboard · MPS"],
      assessmentMpsSummary:["GraceDesk","Assessment Dashboard · MPS Summary"],
      assessmentDifficultyIndex:["GraceDesk","Assessment Dashboard · Difficulty Index"],
      assessmentItemAnalysis:["GraceDesk","Assessment Dashboard · Item Analysis"],
      assessmentLeastMastered:["GraceDesk","Assessment Dashboard · Least Mastered Competencies"],
      philIri:["GraceDesk","Phil-IRI"],
      rma:["GraceDesk","RMA"],
      nutritionalStatus:["GraceDesk","Nutritional Status"],
      profile:["GraceDesk","Teacher Profile"],
      settings:["GraceDesk","Settings"],
      tools:["GraceDesk","Tools"],
    };
    var pageLabel=pageLabels[page]||pageLabels.students;
    $("topbarPageSubtitle").textContent=pageLabel[0];
    $("topbarPageTitle").textContent=pageLabel[1];
    if(showGrades)loadGradeStudents();
    else if(showAttendance)loadAttendance();
    else if(showSummary)loadGradeSummary();
    else if(showPhilIri){
      loadPhilIriPupils();
      loadPhilIriAutoScoringResults();
    }
    else if(showReading){
      loadReadingProgress();
      loadPhilIriSettings();
      loadPhilIriReports();
    }
    else if(showRma)loadRma();
    else if(showAssessmentMps)loadStudents().then(function(rosterLoaded){
      renderMpsReport(rosterLoaded);
      loadMpsEclassScores(rosterLoaded);
      $("mpsNotice").hidden=rosterLoaded;
      $("mpsNotice").classList.toggle("error",!rosterLoaded);
      $("mpsNotice").textContent=rosterLoaded?"":"Could not refresh the class roster: "
        +$("studentNotice").textContent+" You can still enter learner names manually.";
    });
    else if(showAssessmentMpsSummary)loadStudents().then(function(rosterLoaded){
      updateMpsSummaryMetadata();
      return loadMpsSummaryFromEClass(rosterLoaded);
    });
    else if(showNutritionalStatus)loadNutritionalStatusRoster();
    else if(showSf10)loadSf10Roster();
    else if(showEClass)renderEClassTable();
    else if(showProfile){
      $("teacherProfileTitle").focus({preventScroll:true});
      loadTeacherProfile();
    }
    else if(showSettings){
      $("settingsTitle").focus({preventScroll:true});
      $("appearanceSetting").value=appTheme;
      $("settingsNotice").classList.remove("error");
      $("settingsNotice").textContent=appearanceStorageError;
      applyPerformanceMode(performanceModeEnabled);
      $("performanceNotice").classList.toggle("error",Boolean(performanceModeStorageError));
      $("performanceNotice").textContent=performanceModeStorageError;
    }
    else if(showDashboard)loadDashboardOverview();
    else if(!showEClass&&!showSf10)loadStudents();
  }

  function mpsDescriptor(score){
    if(score>=96)return "Mastered";
    if(score>=86)return "Closely Approximating Mastery";
    if(score>=66)return "Moving Towards Mastery";
    if(score>=35)return "Average";
    if(score>=15)return "Low";
    if(score>=5)return "Very Low";
    return "Absolutely No Mastery";
  }

  function populateMpsSubjectOptions(section,preferredSubject){
    var subjects=eClassSubjectOptions.length
      ?eClassSubjectOptions
      :(handledSubjects.length?handledSubjects:availableSubjects);
    var select=$("mpsSubject");
    var previous=preferredSubject||select.value;
    select.replaceChildren();
    if(!subjects.length){
      select.add(new Option("No subjects configured",""));
      select.disabled=true;
      return;
    }
    subjects.forEach(function(subject){select.add(new Option(subject,subject))});
    var matching=Array.from(select.options).find(function(option){
      return option.value.toLowerCase()===String(previous||"").toLowerCase();
    });
    select.value=matching?matching.value:select.options[0].value;
    select.disabled=false;
  }

  function populateItemAnalysisSubjectOptions(section,preferredSubject){
    populateMpsSubjectOptions(section,preferredSubject);
    var source=$("mpsSubject");
    var target=$("itemAnalysisSubject");
    var previous=preferredSubject||target.value;
    target.replaceChildren();
    Array.from(source.options).forEach(function(option){
      target.add(new Option(option.textContent,option.value));
    });
    var matching=Array.from(target.options).find(function(option){
      return option.value.toLowerCase()===String(previous||"").toLowerCase();
    });
    target.value=matching?matching.value:(target.options[0]?target.options[0].value:"");
    target.disabled=!target.options.length||source.disabled;
  }

  function updateDifficultyIndexSummary(){
    var learners=Number($("difficultyIndexLearners").value);
    var analyzed=0,easy=0,moderate=0,difficult=0;
    Array.from($("difficultyIndexRows").rows).forEach(function(row){
      var correct=Number(row.querySelector("[data-difficulty-correct]").value);
      if(!Number.isFinite(learners)||learners<=0||!Number.isFinite(correct)||correct<0||correct>learners)return;
      var df=correct/learners;
      analyzed++;
      if(df>=.81)easy++;
      else if(df>=.20)moderate++;
      else difficult++;
    });
    $("difficultyIndexAnalyzed").textContent=String(analyzed);
    $("difficultyIndexEasy").textContent=String(easy);
    $("difficultyIndexModerate").textContent=String(moderate);
    $("difficultyIndexDifficult").textContent=String(difficult);
  }

  function renderDifficultyIndexRows(){
    var count=Number($("difficultyIndexTotalItems").value);
    count=Number.isInteger(count)&&count>0?Math.min(count,200):10;
    $("difficultyIndexTotalItems").value=String(count);
    var rows=$("difficultyIndexRows");
    var previous=Array.from(rows.rows).map(function(row){
      return row.querySelector("[data-difficulty-correct]").value;
    });
    rows.replaceChildren();
    for(var index=0;index<count;index++){
      var row=document.createElement("tr");
      row.innerHTML="<td>"+(index+1)+"</td>"
        +"<td><input type=\"number\" min=\"0\" step=\"1\" inputmode=\"numeric\" data-difficulty-correct aria-label=\"Correct responses for item "+(index+1)+"\"></td>"
        +"<td data-difficulty-value></td><td data-difficulty-interpretation></td><td data-difficulty-action></td>";
      rows.appendChild(row);
      row.querySelector("[data-difficulty-correct]").value=previous[index]||"";
    }
    updateDifficultyIndexRows();
  }

  function updateDifficultyIndexRows(){
    var learners=Number($("difficultyIndexLearners").value);
    Array.from($("difficultyIndexRows").rows).forEach(function(row){
      var correct=Number(row.querySelector("[data-difficulty-correct]").value);
      var valueCell=row.querySelector("[data-difficulty-value]");
      var interpretationCell=row.querySelector("[data-difficulty-interpretation]");
      var actionCell=row.querySelector("[data-difficulty-action]");
      valueCell.textContent="";
      interpretationCell.textContent="";
      actionCell.textContent="";
      if(!Number.isFinite(learners)||learners<=0||!Number.isFinite(correct)||correct<0||correct>learners)return;
      var df=correct/learners;
      valueCell.textContent=df.toFixed(2);
      if(df>=.81){
        interpretationCell.textContent="Very Easy";
        actionCell.textContent="Revise / Make more challenging";
      }else if(df>=.20){
        interpretationCell.textContent="Moderate / Ideal";
        actionCell.textContent="Retain";
      }else{
        interpretationCell.textContent="Very Difficult";
        actionCell.textContent="Revise / Reteach competency";
      }
    });
    updateDifficultyIndexSummary();
  }

  function renderDifficultyIndexReport(){
    var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
      ?activeStudentSection:defaultStudentSection;
    populateItemAnalysisSubjectOptions(reportSection,$("mpsSubject").value);
    $("difficultyIndexGradeLevel").value=getSectionGrade(reportSection)||defaultStudentGrade||"";
    $("difficultyIndexSection").value=reportSection||"";
    $("difficultyIndexLearners").value="";
    renderDifficultyIndexRows();
  }

  function renderItemAnalysisReport(){
    var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
      ?activeStudentSection:defaultStudentSection;
    var selectedSubject=$("mpsSubject").value||$("itemAnalysisSubject").value;
    populateItemAnalysisSubjectOptions(reportSection,selectedSubject);
    $("itemAnalysisGradeLevel").value=getSectionGrade(reportSection)||defaultStudentGrade||"";
    $("itemAnalysisSection").value=reportSection||"";
    $("itemAnalysisSchoolYear").value=$("teacherProfileSchoolYear").value||"";
    $("itemAnalysisTerm").value=$("mpsTerm").value||$("eClassTerm").value||"Term 1";
    $("itemAnalysisTestType").value=$("mpsTestType").value||"TE";
    $("itemAnalysisTotalItems").value=$("mpsTotalItems").value||"";
    $("itemAnalysisDate").value=$("mpsExaminationDate").value||"";
    $("itemAnalysisLearners").value=$("mpsLearnerCount").textContent||"0";
    var total=Number($("itemAnalysisTotalItems").value);
    var rowCount=Number.isInteger(total)&&total>0&&total<=200?total:10;
    var rows=$("itemAnalysisRows");
    rows.replaceChildren();
    for(var index=1;index<=rowCount;index++){
      var row=document.createElement("tr");
      row.innerHTML="<td>"+index+"</td>"
        +"<td class=\"item-analysis-left\"><input aria-label=\"Learning competency for item "+index+"\" placeholder=\"\"></td>"
        +"<td><input aria-label=\"Difficulty Index for item "+index+"\" inputmode=\"decimal\"></td>"
        +"<td><input aria-label=\"Discrimination Index for item "+index+"\" inputmode=\"decimal\"></td>"
        +"<td class=\"item-analysis-left\"><textarea aria-label=\"Distractor analysis for item "+index+"\" rows=\"1\" placeholder=\"\"></textarea></td>"
        +"<td class=\"item-analysis-left\"><input aria-label=\"Remarks or action for item "+index+"\"></td>";
      rows.appendChild(row);
    }
    $("itemAnalysisCount").textContent="0";
    $("itemAnalysisRetained").textContent="0";
    $("itemAnalysisRevise").textContent="0";
    $("itemAnalysisDiscard").textContent="0";
    $("itemAnalysisLeastMastered").innerHTML="&nbsp;";
    $("itemAnalysisNotice").hidden=true;
  }

  function mpsEclassSubjectValue(subject){
    var aliases={
      "English Language Reading and Literacy":"English",
      "Good Manners and Right Conduct (GMRC)":"GMRC/Values Education",
      "Edukasyong Pantahanan at Pangkabuhayan (EPP)":"EPP / TLE",
      "EPP":"EPP / TLE",
      "TLE":"EPP / TLE",
      "Physical Education and Health (PEH)":"MAPEH"
    };
    return aliases[subject]||subject;
  }

  function mpsSummarySubjectLabel(subject){
    var labels={
      "Araling Panlipunan (AP)":"Araling Panlipunan",
      "GMRC/Values Education":"GMRC / Values Education",
      "EPP / TLE":"EPP/TLE"
    };
    return labels[mpsEclassSubjectValue(subject)]||mpsEclassSubjectValue(subject);
  }

  function renderMpsSummaryRows(subjects){
    var body=$("assessmentMpsSummaryPage").querySelector(".mps-summary-table tbody");
    body.replaceChildren();
    var seen=Object.create(null);
    subjects.forEach(function(subject){
      var canonical=mpsEclassSubjectValue(subject);
      var key=canonical.toLowerCase();
      if(!canonical||seen[key])return;
      seen[key]=true;
      var label=mpsSummarySubjectLabel(canonical);
      var row=document.createElement("tr");
      row.dataset.eclassSubject=canonical;
      row.innerHTML="<td>"+label+"</td>"
        +"<td><input class=\"mps-summary-learners\" type=\"number\" readonly aria-label=\"Number of learners with "+label+" scores\"></td>"
        +"<td><input class=\"mps-summary-items\" type=\"number\" readonly aria-label=\""+label+" test item count\"></td>"
        +"<td><input class=\"mps-summary-average\" type=\"number\" readonly aria-label=\""+label+" average raw score\"></td>"
        +"<td><output class=\"mps-summary-mps\" aria-live=\"polite\"></output></td>"
        +"<td><output class=\"mps-summary-descriptor\" aria-live=\"polite\"></output></td>";
      body.appendChild(row);
    });
  }

  function updateMpsSummaryMetadata(){
    var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
      &&activeStudentSection!=="__unassigned__"?activeStudentSection:defaultStudentSection;
    $("mpsSummarySchoolYear").value=$("teacherProfileSchoolYear").value||"";
    $("mpsSummarySection").value=reportSection||"";
    $("mpsSummaryGrade").value=getSectionGrade(reportSection)||defaultStudentGrade||"";
  }

  async function loadMpsSummaryFromEClass(rosterLoaded){
    var requestId=++mpsSummaryRequestId;
    var notice=$("mpsSummaryNotice");
    notice.classList.remove("error");
    if(!rosterLoaded){
      notice.classList.add("error");
      notice.textContent="Could not load the learner roster: "+$("studentNotice").textContent;
      updateMpsSummary();
      return;
    }
    var term=$("mpsSummaryTerm").value;
    var assessmentType=$("mpsSummaryTestType").value;
    var scoreIndex={ST1:8,ST2:9,TE:10}[assessmentType];
    if(!scoreIndex&&scoreIndex!==0){
      notice.textContent="Select a valid E-Class term and test type.";
      updateMpsSummary();
      return;
    }
    var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
      ?activeStudentSection:defaultStudentSection;
    if(!reportSection||reportSection==="__unassigned__"){
      notice.textContent="Select a class section to load its E-Class results.";
      updateMpsSummary();
      return;
    }
    var sectionSubjects=eClassSubjectOptions.length
      ?eClassSubjectOptions.slice()
      :getTeacherSubjectsForSection(reportSection);
    if(!sectionSubjects.length)sectionSubjects=availableSubjects.slice();
    renderMpsSummaryRows(sectionSubjects);
    var rows=Array.from($("assessmentMpsSummaryPage").querySelectorAll(".mps-summary-table tbody tr"));
    var students=filterStudentsForActiveSection(rosterStudents,reportSection);
    notice.textContent="Loading "+assessmentType+" results from E-Class for "+term+"...";
    var matchedSubjects=0;
    async function getRecord(subject,mapehGroup){
      var query="?term="+encodeURIComponent(term)
        +"&subject="+encodeURIComponent(subject)
        +"&mapehGroup="+encodeURIComponent(mapehGroup||"")
        +"&section="+encodeURIComponent(reportSection);
      return api("/api/e-class/record"+query);
    }
    function validScore(value,totalItems){
      var score=typeof value==="string"&&value.trim()!==""?Number(value):NaN;
      return Number.isFinite(score)&&score>=0&&score<=totalItems?score:NaN;
    }
    var results=await Promise.all(rows.map(async function(row){
      var selectedSubject=row.dataset.eclassSubject;
      var subject=sectionSubjects.find(function(candidate){
        return mpsEclassSubjectValue(candidate).toLowerCase()===selectedSubject.toLowerCase();
      });
      if(!subject)return{row:row,missingSubject:true};
      matchedSubjects++;
      try{
        var scoreTotal=0;
        var learnerCount=0;
        var totalItems=0;
        if(subject==="MAPEH"){
          var mapehRecords=await Promise.all(["Music and Arts","PE and Health"].map(function(group){
            return getRecord(subject,group);
          }));
          if(mapehRecords.some(function(record){return !record.saved}))return{row:row,recordFound:false};
          var mapehItemTotals=mapehRecords.map(function(record){
            return record.highestScores&&Number(record.highestScores[scoreIndex]);
          });
          if(mapehItemTotals.some(function(total){return !Number.isInteger(total)||total<=0})){
            return{row:row,recordFound:true,totalItems:null,learnerCount:0,averageRawScore:null};
          }
          totalItems=mapehItemTotals.reduce(function(total,value){return total+value},0);
          var mapehScores=mapehRecords.map(function(record){
            return record.scores&&typeof record.scores==="object"?record.scores:{};
          });
          students.forEach(function(student){
            var groupScores=mapehScores.map(function(scores){return scores[student.id]});
            var rawScores=groupScores.map(function(scores,index){
              return validScore(Array.isArray(scores)?scores[scoreIndex]:"",mapehItemTotals[index]);
            });
            if(rawScores.every(Number.isFinite)){
              scoreTotal+=rawScores.reduce(function(total,value){return total+value},0);
              learnerCount++;
            }
          });
        }else{
          var record=await getRecord(subject);
          if(!record.saved)return{row:row,recordFound:false};
          totalItems=record.highestScores&&Number(record.highestScores[scoreIndex]);
          var scores=record.scores&&typeof record.scores==="object"?record.scores:{};
          if(Number.isInteger(totalItems)&&totalItems>0){
            students.forEach(function(student){
              var studentScores=scores[student.id];
              var score=validScore(Array.isArray(studentScores)?studentScores[scoreIndex]:"",totalItems);
              if(Number.isFinite(score)){
                scoreTotal+=score;
                learnerCount++;
              }
            });
          }
        }
        return{
          row:row,
          recordFound:true,
          totalItems:Number.isInteger(totalItems)&&totalItems>0?totalItems:null,
          learnerCount:learnerCount,
          averageRawScore:learnerCount?scoreTotal/learnerCount:null
        };
      }catch(error){
        return{row:row,error:error.message};
      }
    }));
    if(requestId!==mpsSummaryRequestId)return;
    var failures=[];
    var recordsFound=0;
    results.forEach(function(result){
      if(result.error){
        failures.push(result.row.dataset.eclassSubject+": "+result.error);
        return;
      }
      if(result.missingSubject||!result.recordFound)return;
      recordsFound++;
      if(result.learnerCount>0&&result.totalItems){
        result.row.querySelector(".mps-summary-learners").value=String(result.learnerCount);
        result.row.querySelector(".mps-summary-items").value=String(result.totalItems);
        result.row.querySelector(".mps-summary-average").value=String(result.averageRawScore);
      }
    });
    updateMpsSummary();
    notice.classList.toggle("error",failures.length===results.length);
    notice.textContent=failures.length
      ?(failures.length===results.length
        ?"Could not load E-Class results: "+failures.join("; ")
        :"Some E-Class subjects could not be loaded: "+failures.join("; "))
      :recordsFound
        ?"Summary refreshed from saved E-Class "+assessmentType+" results for "+term+"."
        :matchedSubjects
          ?"No saved E-Class "+assessmentType+" results found for "+term+"."
          :"No matching E-Class subjects are configured for this section.";
  }

  function updateMpsSummary(){
    var subjectCount=0;
    var mpsValues=[];
    $("assessmentMpsSummaryPage").querySelectorAll(".mps-summary-table tbody tr").forEach(function(row){
      var learners=row.querySelector(".mps-summary-learners");
      var items=row.querySelector(".mps-summary-items");
      var average=row.querySelector(".mps-summary-average");
      var mpsOutput=row.querySelector(".mps-summary-mps");
      var descriptorOutput=row.querySelector(".mps-summary-descriptor");
      var subjectName=row.dataset.eclassSubject;
      var learnerCount=learners.value===""?NaN:Number(learners.value);
      var totalItems=items.value===""?NaN:Number(items.value);
      var averageRawScore=average.value===""?NaN:Number(average.value);
      var validLearners=Number.isInteger(learnerCount)&&learnerCount>0;
      var validItems=Number.isInteger(totalItems)&&totalItems>0;
      var validAverage=Number.isFinite(averageRawScore)&&averageRawScore>=0
        &&validItems&&averageRawScore<=totalItems;
      mpsOutput.textContent="";
      descriptorOutput.textContent="";
      if(!subjectName||!validLearners||!validItems||!validAverage)return;
      subjectCount++;
      var mps=averageRawScore/totalItems*100;
      mpsValues.push(mps);
      var displayedMps=Number(mps.toFixed(2));
      mpsOutput.textContent=displayedMps.toFixed(2)+"%";
      descriptorOutput.textContent=mpsDescriptor(Math.floor(displayedMps));
    });
    $("mpsSummarySubjectCount").textContent=String(subjectCount);
    var generalAverage=mpsValues.length
      ?mpsValues.reduce(function(total,value){return total+value},0)/mpsValues.length:NaN;
    var displayedGeneralAverage=Number.isFinite(generalAverage)?Number(generalAverage.toFixed(2)):NaN;
    $("mpsSummaryGeneralAverage").textContent=Number.isFinite(displayedGeneralAverage)
      ?displayedGeneralAverage.toFixed(2)+"%":"";
    $("mpsSummaryOverallDescriptor").textContent=Number.isFinite(generalAverage)
      ?mpsDescriptor(Math.floor(displayedGeneralAverage)):"";
  }

  function renderMpsReport(rosterLoaded){
    var reportSection=activeStudentSection&&activeStudentSection!=="__all__"
      ?activeStudentSection:defaultStudentSection;
    var context=[currentUser&&currentUser.id||"",currentUser&&currentUser.classCode||"",reportSection].join("|");
    var previousScores=Object.create(null);
    if(context===mpsReportContext){
      mpsLearners.forEach(function(learner){
        if(learner.id)previousScores[learner.id]=learner.score;
      });
    }
    if(context!==mpsReportContext){
      mpsReportContext=context;
      $("mpsSubject").value="";
      $("mpsGradeLevel").value=getSectionGrade(reportSection)||defaultStudentGrade||"";
      $("mpsSection").value=reportSection;
      $("mpsSchoolYear").value=$("teacherProfileSchoolYear").value;
      $("mpsTerm").value=$("eClassTerm").value;
      $("mpsTestType").value="TE";
      $("mpsTotalItems").value="";
      $("mpsExaminationDate").value="";
    }
    populateMpsSubjectOptions(reportSection,context===mpsReportContext?$("mpsSubject").value:"");
    $("mpsGradeLevel").value=getSectionGrade(reportSection)||defaultStudentGrade||"";
    $("mpsSection").value=reportSection;
    var students=rosterLoaded===false?[]:filterStudentsForActiveSection(rosterStudents,reportSection);
    mpsLearners=students.length?students.map(function(student){
      var id=String(student.id||"");
      return {
        id:id,
        name:[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", "),
        score:previousScores[id]||"",
      };
    }):Array.from({length:10},function(){return{id:"",name:"",score:""}});
    renderMpsLearnerRows();
    updateMpsReport();
  }

  async function loadMpsEclassScores(rosterLoaded){
    var requestId=++mpsRecordRequestId;
    if(!rosterLoaded){
      $("mpsNotice").hidden=false;
      $("mpsNotice").classList.add("error");
      $("mpsNotice").textContent="E-Class scores cannot be loaded until the learner roster is available.";
      return;
    }
    var subject=$("mpsSubject").value;
    var eclassSubject=mpsEclassSubjectValue(subject);
    var assessmentType=$("mpsTestType").value;
    var term=$("mpsTerm").value;
    if(!subject||!assessmentType||!term)return;
    $("mpsNotice").hidden=false;
    $("mpsNotice").classList.remove("error");
    $("mpsNotice").textContent="Loading "+assessmentType+" scores from E-Class...";
    try{
      var query="?term="+encodeURIComponent(term)
        +"&subject="+encodeURIComponent(eclassSubject)
        +"&mapehGroup="+encodeURIComponent($("eClassMapehGroup").value)
        +"&section="+encodeURIComponent($("mpsSection").value||activeStudentSection);
      var record=await api("/api/e-class/record"+query);
      if(requestId!==mpsRecordRequestId)return;
      var scoreIndex={ST1:8,ST2:9,TE:10}[assessmentType];
      var total=record.saved&&Array.isArray(record.highestScores)
        ?Number(record.highestScores[scoreIndex]):NaN;
      var scores=record.saved&&record.scores&&typeof record.scores==="object"?record.scores:{};
      var updatedDate="";
      if(record.saved&&record.updated){
        var updated=new Date(record.updated);
        if(!Number.isNaN(updated.getTime())){
          updatedDate=updated.getFullYear()+"-"+String(updated.getMonth()+1).padStart(2,"0")
            +"-"+String(updated.getDate()).padStart(2,"0");
        }
      }
      $("mpsExaminationDate").value=updatedDate;
      mpsLearners.forEach(function(learner){
        var rowScores=scores[learner.id];
        learner.score=Array.isArray(rowScores)&&typeof rowScores[scoreIndex]==="string"
          ?rowScores[scoreIndex]:"";
      });
      $("mpsTotalItems").value=Number.isFinite(total)&&total>0?String(total):"";
      renderMpsLearnerRows();
      updateMpsReport();
      if(!$("assessmentItemAnalysisPage").hidden)renderItemAnalysisReport();
      $("mpsNotice").hidden=false;
      $("mpsNotice").textContent=record.saved
        ?"Linked to E-Class "+assessmentType+" ("+(assessmentType==="ST1"?"Summative Test 1":assessmentType==="ST2"?"Summative Test 2":"Term Exam")+") for "+term+"."
        :"No saved E-Class record found for "+assessmentType+" and "+term+".";
    }catch(error){
      if(requestId!==mpsRecordRequestId)return;
      $("mpsNotice").classList.add("error");
      $("mpsNotice").textContent="Could not load E-Class "+assessmentType+" scores: "+error.message;
    }
  }

  function renderMpsLearnerRows(){
    var tbody=$("mpsLearnerRows");
    var fragment=document.createDocumentFragment();
    mpsLearners.forEach(function(learner,index){
      var row=document.createElement("tr");
      var numberCell=document.createElement("td");
      numberCell.textContent=String(index+1);
      row.appendChild(numberCell);
      var nameCell=document.createElement("td");
      nameCell.className="mps-name-cell";
      nameCell.textContent=learner.name;
      row.appendChild(nameCell);
      var scoreCell=document.createElement("td");
      var scoreInput=document.createElement("input");
      scoreInput.type="number";
      scoreInput.min="0";
      scoreInput.step="any";
      scoreInput.inputMode="decimal";
      scoreInput.setAttribute("aria-label","Raw score, row "+(index+1));
      scoreInput.dataset.mpsScore=String(index);
      scoreInput.readOnly=true;
      scoreInput.value=learner.score;
      scoreCell.appendChild(scoreInput);
      row.appendChild(scoreCell);
      var totalCell=document.createElement("td");
      totalCell.dataset.mpsRowTotal=String(index);
      row.appendChild(totalCell);
      var percentageCell=document.createElement("td");
      percentageCell.dataset.mpsPercentage=String(index);
      row.appendChild(percentageCell);
      var descriptorCell=document.createElement("td");
      descriptorCell.dataset.mpsDescriptor=String(index);
      row.appendChild(descriptorCell);
      fragment.appendChild(row);
    });
    tbody.replaceChildren(fragment);
  }

  function updateMpsReport(){
    var totalItems=Number($("mpsTotalItems").value);
    var validTotal=Number.isInteger(totalItems)&&totalItems>0;
    var namedLearners=mpsLearners.filter(function(learner){return learner.name.trim()!==""});
    var totalText=validTotal?String(totalItems):"";
    $("mpsSummaryTotalItems").textContent=totalText;
    $("mpsLearnerCount").textContent=String(namedLearners.length);
    var complete=validTotal&&namedLearners.length>0;
    var percentageSum=0;
    mpsLearners.forEach(function(learner,index){
      var scoreInput=$("mpsLearnerRows").querySelector('[data-mps-score="'+index+'"]');
      var totalCell=$("mpsLearnerRows").querySelector('[data-mps-row-total="'+index+'"]');
      var percentageCell=$("mpsLearnerRows").querySelector('[data-mps-percentage="'+index+'"]');
      var descriptorCell=$("mpsLearnerRows").querySelector('[data-mps-descriptor="'+index+'"]');
      var rawScore=learner.score===""?NaN:Number(learner.score);
      var hasScore=learner.score!=="";
      var validScore=validTotal&&Number.isFinite(rawScore)&&rawScore>=0&&rawScore<=totalItems;
      scoreInput.max=validTotal?String(totalItems):"";
      scoreInput.setCustomValidity(hasScore&&!validTotal
        ?"Enter a valid total number of items first."
        :hasScore&&!validScore?"Raw score must be between 0 and the total number of items.":"");
      scoreInput.setAttribute("aria-invalid",String(hasScore&&!validScore));
      totalCell.textContent=validTotal?String(totalItems):"";
      percentageCell.textContent="";
      descriptorCell.textContent="";
      if(!learner.name.trim())return;
      if(!hasScore||!validScore){
        complete=false;
        return;
      }
      var percentage=rawScore/totalItems*100;
      percentageCell.textContent=percentage.toFixed(2)+"%";
      descriptorCell.textContent=mpsDescriptor(percentage);
      percentageSum+=percentage;
    });
    $("mpsAverage").textContent="";
    $("mpsAverageDescriptor").textContent="";
    if(complete){
      var average=percentageSum/namedLearners.length;
      $("mpsAverage").textContent=average.toFixed(2);
      $("mpsAverageDescriptor").textContent=mpsDescriptor(average);
    }
  }

  async function loadPhilIriPupils(){
    $("philIriScoreCount").textContent="Loading pupils...";
    $("philIriScoreForm").hidden=true;
    $("philIriScoreEmpty").hidden=true;
    $("philIriScoreNotice").textContent="";
    $("philIriScoreNotice").classList.remove("error");
    try{
      var responses=await Promise.all([
        api("/api/students"),
        api("/api/phil-iri/settings")
      ]);
      var result=responses[0];
      philIriScoreGuide=responses[1].scoringGuide||null;
      if(!Array.isArray(result.students)){
        throw new Error("The roster response is outdated. Restart the portal server to load the updated backend.");
      }
      var students=filterStudentsForActiveSection(result.students);
      updatePhilIriScoreResults({});
      renderPhilIriScoreForm(students);
    }catch(error){
      $("philIriScoreCount").textContent="Unable to load pupils";
      $("philIriScoreNotice").textContent=error.message;
      $("philIriScoreNotice").classList.add("error");
    }
  }

  function philIriStartingPassage(score,guide,language){
    if(!guide||!guide.supported||!Number.isInteger(score)||score>=guide.passingScore)return "";
    var range=guide.referralRanges.find(function(item){return score>=item.minimum&&score<=item.maximum});
    if(!range)return "";
    var gradeMatch=String(guide.grade).match(/\d+/);
    var gradeNumber=gradeMatch?Number(gradeMatch[0]):0;
    var minimumGrade=guide.minimumPassageGrade[language]||1;
    var passageGrade=Math.max(minimumGrade,gradeNumber-range.levelsBelow);
    var gradeDescription="Grade "+passageGrade+" passage";
    return passageGrade===gradeNumber-range.levelsBelow
      ?gradeDescription+" ("+range.levelsBelow+" levels below)"
      :gradeDescription+" (lowest available "+language+" passage)";
  }

  function calculatePhilIriScore(data,guide,mode,language){
    var readScore=function(field){
      return data[field]===null||data[field]===undefined||data[field]===""?"":Number(data[field]);
    };
    var gstScore=readScore("gstScore");
    var totalWords=readScore("totalWords");
    var miscues=readScore("miscues");
    var timeSeconds=readScore("timeSeconds");
    var comprehensionCorrect=readScore("comprehensionCorrect");
    var comprehensionTotal=readScore("comprehensionTotal");
    mode=mode||data.assessmentMode||"Oral Reading";
    var eligibleForIndividual=!guide||(guide.supported&&Number.isInteger(gstScore)&&gstScore<guide.passingScore);
    var oralReading=eligibleForIndividual&&mode==="Oral Reading"
      &&typeof totalWords==="number"&&Number.isFinite(totalWords)&&totalWords>0
      &&typeof miscues==="number"&&Number.isFinite(miscues)&&miscues>=0&&miscues<=totalWords
      ?(totalWords-miscues)/totalWords:null;
    var wordsPerMinute=eligibleForIndividual&&mode!=="Listening Comprehension"
      &&typeof totalWords==="number"&&Number.isFinite(totalWords)&&totalWords>0
      &&typeof timeSeconds==="number"&&Number.isFinite(timeSeconds)&&timeSeconds>0
      ?totalWords/(timeSeconds/60):null;
    var comprehension=eligibleForIndividual&&typeof comprehensionTotal==="number"&&Number.isFinite(comprehensionTotal)
      &&comprehensionTotal>0&&typeof comprehensionCorrect==="number"
      &&Number.isFinite(comprehensionCorrect)&&comprehensionCorrect>=0
      &&comprehensionCorrect<=comprehensionTotal
      ?comprehensionCorrect/comprehensionTotal:null;
    var readingLevel="";
    if(eligibleForIndividual&&mode==="Oral Reading"&&oralReading!==null&&comprehension!==null){
      if(oralReading>=0.97&&comprehension>=0.8)readingLevel="Independent";
      else if(oralReading<=0.89||comprehension<=0.58)readingLevel="Frustration";
      else readingLevel="Instructional";
    }else if(eligibleForIndividual&&mode!=="Oral Reading"&&comprehension!==null){
      readingLevel=comprehension>=0.8?"Independent"
        :comprehension<=0.58?"Frustration":"Instructional";
    }
    var startingPassage=guide&&guide.supported
      ?philIriStartingPassage(gstScore,guide,language):"";
    return {
      gstStatus:gstScore===""||!guide||!guide.supported?""
        :gstScore>=guide.passingScore?"PASS GST":"INDIVIDUAL ASSESSMENT",
      gstTotalItems:guide&&guide.supported?guide.totalItems:null,
      gstPassingScore:guide&&guide.supported?guide.passingScore:null,
      oralReading:oralReading,
      wordsPerMinute:wordsPerMinute,
      comprehension:comprehension,
      readingLevel:readingLevel,
      startingPassage:startingPassage,
      intervention:readingLevel==="Independent"?"Enrichment"
        :readingLevel==="Instructional"?"Guided Reading"
          :readingLevel==="Frustration"?"Intensive Remediation":"",
    };
  }

  function renderPhilIriScoreForm(students){
    var count=$("philIriScoreCount");
    var empty=$("philIriScoreEmpty");
    var form=$("philIriScoreForm");
    var pupilSelect=$("philIriScorePupil");
    var previousStudentId=pupilSelect.value;
    count.textContent=students.length+" pupil"+(students.length===1?"":"s");
    form.hidden=students.length===0;
    empty.hidden=students.length!==0;
    pupilSelect.replaceChildren(new Option("Choose a pupil",""));
    students.forEach(function(student){
      var name=[student.lastName,student.firstName,student.middleName].filter(Boolean).join(", ");
      pupilSelect.add(new Option(name+" (LRN "+student.lrn+")",student.id));
    });
    var selectedStudentExists=students.some(function(student){return student.id===previousStudentId});
    pupilSelect.value=selectedStudentExists?previousStudentId:students.length?students[0].id:"";
    pupilSelect.onchange=loadSelectedPhilIriScores;
    ["philIriScorePeriod","philIriScoreType","philIriScoreLanguage","philIriScoreMode"].forEach(function(id){
      $(id).onchange=loadSelectedPhilIriScores;
    });
    form.querySelectorAll("[data-score-field]").forEach(function(input){
      input.oninput=saveSelectedPhilIriScores;
      input.disabled=false;
    });
    $("philIriScoreDate").oninput=function(){philIriScoreEditVersion+=1};
    form.onsubmit=function(event){event.preventDefault()};
    $("savePhilIriAutoScore").disabled=students.length===0;
    if(!$("philIriScoreDate").value)$("philIriScoreDate").value=localISODate();
    loadSelectedPhilIriScores();
  }

  function philIriScoreContextKey(){
    return [
      $("philIriScorePupil").value,
      $("philIriScorePeriod").value,
      $("philIriScoreType").value,
      $("philIriScoreLanguage").value,
      $("philIriScoreMode").value
    ].join("|");
  }

  async function loadSelectedPhilIriScores(){
    var requestId=++philIriScoreLoadRequestId;
    var editVersion=philIriScoreEditVersion;
    var studentId=$("philIriScorePupil").value;
    var data=philIriScoreData[philIriScoreContextKey()]||{
      gstScore:"",totalWords:"",miscues:"",timeSeconds:"",comprehensionCorrect:"",comprehensionTotal:"",
    };
    $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){
      input.value=data[input.dataset.scoreField]===null||data[input.dataset.scoreField]===undefined
        ?"":data[input.dataset.scoreField];
      input.disabled=false;
    });
    $("savePhilIriAutoScore").disabled=!studentId;
    updatePhilIriScoreResults(data);
    $("philIriScoreNotice").textContent="";
    $("philIriScoreNotice").classList.remove("error");
    if(!studentId){
      $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){input.disabled=true});
      return;
    }
    try{
      var query=new URLSearchParams({
        studentId:studentId,
        period:$("philIriScorePeriod").value,
        assessmentType:$("philIriScoreType").value,
        language:$("philIriScoreLanguage").value
      });
      var saved=await api("/api/phil-iri/auto-scoring?"+query.toString());
      if(requestId!==philIriScoreLoadRequestId)return;
      if(editVersion!==philIriScoreEditVersion)return;
      var savedScore=saved.autoScoring;
      var mode=$("philIriScoreMode").value;
      if(savedScore&&savedScore.modeResults){
        data={
          gstScore:savedScore.gstScore,
          gstTotalItems:savedScore.gstTotalItems,
          gstPassingScore:savedScore.gstPassingScore,
          assessedDate:savedScore.assessedDate,
          assessor:savedScore.assessor,
          ...(savedScore.modeResults[mode]||{}),
          assessmentMode:mode,
        };
      }else if(savedScore&&(!savedScore.assessmentMode||savedScore.assessmentMode===mode)){
        data=savedScore;
      }else{
        data={
          gstScore:savedScore?savedScore.gstScore:"",
          gstTotalItems:savedScore?savedScore.gstTotalItems:"",
          gstPassingScore:savedScore?savedScore.gstPassingScore:"",
          totalWords:"",miscues:"",timeSeconds:"",
          comprehensionCorrect:"",comprehensionTotal:"",
          assessmentMode:mode,
        };
      }
      philIriScoreData[philIriScoreContextKey()]=data;
      $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){
        input.value=data[input.dataset.scoreField]===null||data[input.dataset.scoreField]===undefined
          ?"":data[input.dataset.scoreField];
      });
      $("savePhilIriAutoScore").disabled=false;
      $("philIriScoreDate").value=data.assessedDate||localISODate();
      updatePhilIriScoreResults(data);
      if(saved.autoScoring){
        $("philIriScoreNotice").textContent="Loaded saved "+saved.period+" "+saved.assessmentType+" "+saved.language+" scores.";
      }
    }catch(error){
      if(requestId!==philIriScoreLoadRequestId)return;
      $("philIriScoreNotice").textContent=error.message;
      $("philIriScoreNotice").classList.add("error");
    }
  }

  function saveSelectedPhilIriScores(){
    var studentId=$("philIriScorePupil").value;
    if(!studentId)return;
    var key=philIriScoreContextKey();
    var data=philIriScoreData[key]||{};
    $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){
      data[input.dataset.scoreField]=input.value;
    });
    philIriScoreData[key]=data;
    philIriScoreEditVersion+=1;
    updatePhilIriScoreResults(data);
  }

  async function persistSelectedPhilIriScores(){
    var studentId=$("philIriScorePupil").value;
    if(!studentId){
      $("philIriScoreNotice").textContent="Choose a pupil before saving scores.";
      $("philIriScoreNotice").classList.add("error");
      return;
    }
    var data=philIriScoreData[philIriScoreContextKey()]||{};
    $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){
      data[input.dataset.scoreField]=input.value;
    });
    var guide=philIriScoreGuide;
    var gstScore=Number(data.gstScore);
    var includeIndividualScores=guide&&guide.supported
      &&data.gstScore!==""&&Number.isInteger(gstScore)&&gstScore<guide.passingScore;
    var button=$("savePhilIriAutoScore");
    var contextSelectors=["philIriScorePupil","philIriScorePeriod","philIriScoreType","philIriScoreLanguage","philIriScoreMode"]
      .map(function(id){return $(id)});
    var scoreInputs=Array.from($("philIriScoreForm").querySelectorAll("[data-score-field]"));
    contextSelectors.forEach(function(select){select.disabled=true});
    scoreInputs.forEach(function(input){input.disabled=true});
    $("philIriScoreDate").disabled=true;
    button.disabled=true;
    button.textContent="Saving...";
    $("philIriScoreNotice").textContent="";
    $("philIriScoreNotice").classList.remove("error");
    try{
      var saved=await api("/api/phil-iri/auto-scoring",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          studentId:studentId,
          period:$("philIriScorePeriod").value,
          assessmentType:$("philIriScoreType").value,
          language:$("philIriScoreLanguage").value,
          assessmentMode:$("philIriScoreMode").value,
          assessedDate:$("philIriScoreDate").value,
          gstScore:data.gstScore,
          totalWords:includeIndividualScores?data.totalWords:"",
          miscues:includeIndividualScores?data.miscues:"",
          timeSeconds:includeIndividualScores?data.timeSeconds:"",
          comprehensionCorrect:includeIndividualScores?data.comprehensionCorrect:"",
          comprehensionTotal:includeIndividualScores?data.comprehensionTotal:""
        })
      });
      var savedScore=saved.autoScoring;
      var mode=$("philIriScoreMode").value;
      data={
        gstScore:savedScore.gstScore,
        gstTotalItems:savedScore.gstTotalItems,
        gstPassingScore:savedScore.gstPassingScore,
        assessedDate:savedScore.assessedDate,
        assessor:savedScore.assessor,
        ...(savedScore.modeResults[mode]||{}),
        assessmentMode:mode,
      };
      philIriScoreData[philIriScoreContextKey()]=data;
      updatePhilIriScoreResults(data);
      var resultsRefreshed=await loadPhilIriAutoScoringResults();
      $("philIriScoreNotice").textContent=resultsRefreshed
        ?"Saved "+saved.period+" "+saved.assessmentType+" "+saved.language+" PHIL-IRI scores. Results tab updated."
        :"Scores saved, but the Results tab could not refresh. Open Results and select Refresh Results.";
    }catch(error){
      $("philIriScoreNotice").textContent=error.message;
      $("philIriScoreNotice").classList.add("error");
    }finally{
      contextSelectors.forEach(function(select){select.disabled=false});
      scoreInputs.forEach(function(input){input.disabled=false});
      $("philIriScoreDate").disabled=false;
      button.textContent="Save PHIL-IRI Scores";
      updatePhilIriScoreResults(data);
    }
  }

  function updatePhilIriScoreResults(data){
    var mode=$("philIriScoreMode").value;
    var language=$("philIriScoreLanguage").value;
    var guide=philIriScoreGuide;
    var result=calculatePhilIriScore(data,guide,mode,language);
    var guideText=guide&&guide.supported
      ?guide.grade+" reference: "+guide.totalItems+" GST items; refer learners below "+guide.passingScore
        +" for individualized assessment. "+(guide.durationMinutes
          ?"GST administration time limit: "+guide.durationMinutes+" minutes. ":"")
        +(guide.source==="Phil-IRI for Junior High School Manual 2024"
          ?"For official JHS baseline and end-of-year assessment, use BOSY Pretest and EOSY Posttest; MOSY may be used for interim progress."
          :"The GST score of 14/20 or higher completes screening; lower scores need graded-passage assessment.")
      :"The uploaded PHIL-IRI references cover Grades 3–10. Set a supported class grade to use this scoring form.";
    $("philIriScoringGuide").textContent=guideText;
    $("philIriScoringGuide").classList.toggle("error",!guide||!guide.supported);
    $("philIriScoreGstHint").textContent=guide&&guide.supported
      ?"Enter the raw score out of "+guide.totalItems+". Passing score: "+guide.passingScore+"."
      :"Scoring is unavailable until the class grade is within the reference manuals.";
    $("philIriScoreGstScore").max=guide&&guide.supported?String(guide.totalItems):"";
    $("philIriScoreGstScore").disabled=!guide||!guide.supported;
    $("philIriScoreModeHint").textContent=mode==="Oral Reading"
      ?"Record words, miscues, reading time, and comprehension. Reading level uses both word-reading accuracy and comprehension."
      :mode==="Silent Reading"
        ?"Record passage length, reading time, and comprehension. Reading level is based on comprehension; oral miscues are not scored."
        :"Record comprehension after the passage is read aloud by the assessor.";
    $("philIriScoreWordsField").hidden=mode==="Listening Comprehension";
    $("philIriScoreMiscuesField").hidden=mode!=="Oral Reading";
    $("philIriScoreTimeField").hidden=mode==="Listening Comprehension";
    var gstScore=Number($("philIriScoreGstScore").value);
    var eligibleForIndividual=guide&&guide.supported
      &&$("philIriScoreGstScore").value!==""&&gstScore<guide.passingScore;
    $("philIriScoreForm").querySelectorAll("[data-score-field]").forEach(function(input){
      if(input.dataset.scoreField!=="gstScore")input.disabled=!eligibleForIndividual;
    });
    $("philIriGstStatus").textContent=result.gstStatus||"—";
    $("philIriOralReading").textContent=result.oralReading===null?"—":(result.oralReading*100).toFixed(1)+"%";
    $("philIriReadingRate").textContent=result.wordsPerMinute===null?"—":result.wordsPerMinute.toFixed(2);
    $("philIriComprehension").textContent=result.comprehension===null?"—":(result.comprehension*100).toFixed(1)+"%";
    $("philIriReadingLevel").textContent=result.readingLevel||"—";
    $("philIriStartingPassage").textContent=result.startingPassage||"—";
    $("philIriSuggestedIntervention").textContent=result.intervention||"—";
    $("savePhilIriAutoScore").disabled=!$("philIriScorePupil").value||!guide||!guide.supported
      ||$("philIriScoreGstScore").value===""||!Number.isInteger(gstScore)||gstScore<0||gstScore>guide.totalItems;
  }

  function showPhilIriTab(tab){
    var showResults=tab==="results";
    var showScores=tab==="scoring";
    var showReadingSummary=tab==="reading-summary";
    var showAralProgram=tab==="aral-program";
    $("philIriResultsPanel").hidden=!showResults;
    $("philIriAutoScoringPanel").hidden=!showScores;
    $("philIriReadingSummaryPanel").hidden=!showReadingSummary;
    $("philIriAralProgramPanel").hidden=!showAralProgram;
    $("philIriResultsTab").setAttribute("aria-selected",String(showResults));
    $("philIriAutoScoringTab").setAttribute("aria-selected",String(showScores));
    $("philIriReadingSummaryTab").setAttribute("aria-selected",String(showReadingSummary));
    $("philIriAralProgramTab").setAttribute("aria-selected",String(showAralProgram));
    if(showResults)loadPhilIriAutoScoringResults();
    if(showReadingSummary)loadPhilIriReadingSummary();
  }

  async function loadPhilIriAutoScoringResults(){
    var requestId=++philIriResultsRequestId;
    var results=$("philIriLanguageResults");
    var empty=$("philIriResultsEmpty");
    var rowsByLanguage={English:$("philIriEnglishResultsRows"),Filipino:$("philIriFilipinoResultsRows")};
    var notice=$("philIriResultsNotice");
    results.hidden=true;
    empty.hidden=true;
    Object.keys(rowsByLanguage).forEach(function(language){rowsByLanguage[language].replaceChildren()});
    notice.textContent="Loading saved results...";
    notice.classList.remove("error");
    try{
      var period=$("philIriResultsCycle").value;
      var assessmentTypes=["Pretest","Posttest"];
      var requests=assessmentTypes.map(function(assessmentType){
        var query=new URLSearchParams({period:period,assessmentType:assessmentType});
        return api("/api/phil-iri/assessments?"+query.toString());
      });
      var reports=await Promise.all(requests);
      if(requestId!==philIriResultsRequestId)return true;
      reports.forEach(function(report){
        filterStudentsForActiveSection(report.students).forEach(function(student){
          READING_LANGUAGES_LOCAL.forEach(function(language){
            var entry=student.reading&&student.reading[language];
            var score=entry&&entry.data&&entry.data.autoScoring;
            if(!score)return;
            var modeResults=score.modeResults&&typeof score.modeResults==="object"
              ?score.modeResults:{};
            var modes=Object.keys(modeResults);
            if(!modes.length&&score.readingLevel)modes=[score.assessmentMode||"Oral Reading"];
            if(!modes.length)modes=["GST only"];
            modes.forEach(function(mode){
              var modeScore=modeResults[mode]||score;
              var row=document.createElement("tr");
              [
                student.name,
                student.lrn,
                report.period,
                report.assessmentType,
                mode,
                score.gstScore===null||score.gstScore===undefined?"—"
                  :String(score.gstScore)+(score.gstTotalItems?"/"+score.gstTotalItems:""),
                score.gstStatus||"—",
                modeScore.totalWords===null||modeScore.totalWords===undefined?"—":String(modeScore.totalWords),
                modeScore.miscues===null||modeScore.miscues===undefined?"—":String(modeScore.miscues),
                modeScore.oralReading===null||modeScore.oralReading===undefined
                  ?"—":(modeScore.oralReading*100).toFixed(1)+"%",
                modeScore.wordsPerMinute===null||modeScore.wordsPerMinute===undefined
                  ?"—":Number(modeScore.wordsPerMinute).toFixed(2),
                modeScore.comprehension===null||modeScore.comprehension===undefined
                  ?"—":(modeScore.comprehension*100).toFixed(1)+"%",
                modeScore.readingLevel||"—",
                modeScore.startingPassage||"—",
                modeScore.intervention||"—",
                modeScore.assessedDate||score.assessedDate||entry.assessedDate||"—"
              ].forEach(function(value){appendTextCell(row,value)});
              rowsByLanguage[language].append(row);
            });
          });
        });
      });
      var totalResults=Object.keys(rowsByLanguage).reduce(function(total,language){return total+rowsByLanguage[language].children.length},0);
      results.hidden=totalResults===0;
      empty.hidden=totalResults!==0;
      notice.textContent=totalResults
        ?totalResults+" saved scoring result"+(totalResults===1?"":"s")+"."
        :"";
      return true;
    }catch(error){
      if(requestId!==philIriResultsRequestId)return true;
      notice.textContent=error.message;
      notice.classList.add("error");
      return false;
    }
  }

  function philIriReadingLevelIndex(level){
    var normalized=String(level||"").trim().toLowerCase();
    return ["non-reader","frustration","instructional","independent"].indexOf(normalized);
  }

  function philIriReadingLevelClass(level){
    var index=philIriReadingLevelIndex(level);
    return ["philiri-level-non-reader","philiri-level-frustration","philiri-level-instructional","philiri-level-independent"][index]||"";
  }

  function renderPhilIriReadingProgress(cell,periodLevels,studentName,language){
    var levels=["Non-reader","Frustration","Instructional","Independent"];
    var colors=["#667085","#b42318","#b54708","#16803c"];
    var xPositions=[62,104,146];
    var chart=document.createElementNS("http://www.w3.org/2000/svg","svg");
    chart.setAttribute("class","philiri-progress-chart");
    chart.setAttribute("viewBox","0 0 180 92");
    chart.setAttribute("role","img");
    var description=levels.map(function(level,index){return level+" at chart position "+String(index+1)}).join(", ");
    chart.setAttribute("aria-label",studentName+" "+language+" reading-level progress: "+description);
    var title=document.createElementNS("http://www.w3.org/2000/svg","title");
    title.textContent=studentName+" — "+language+" reading level by cycle";
    chart.appendChild(title);
    levels.forEach(function(level,index){
      var y=64-index*16;
      var grid=document.createElementNS("http://www.w3.org/2000/svg","line");
      grid.setAttribute("class","progress-grid");
      grid.setAttribute("x1","52");
      grid.setAttribute("x2","158");
      grid.setAttribute("y1",String(y));
      grid.setAttribute("y2",String(y));
      chart.appendChild(grid);
      var label=document.createElementNS("http://www.w3.org/2000/svg","text");
      label.setAttribute("class","progress-axis");
      label.setAttribute("x","0");
      label.setAttribute("y",String(y+3));
      label.textContent=level;
      chart.appendChild(label);
    });
    var periods=["BOSY","MOSY","EOSY"];
    periods.forEach(function(period,index){
      var xLabel=document.createElementNS("http://www.w3.org/2000/svg","text");
      xLabel.setAttribute("class","progress-axis");
      xLabel.setAttribute("text-anchor","middle");
      xLabel.setAttribute("x",String(xPositions[index]));
      xLabel.setAttribute("y","84");
      xLabel.textContent=period;
      chart.appendChild(xLabel);
    });
    for(var periodIndex=0;periodIndex<periods.length-1;periodIndex++){
      var firstLevel=periodLevels[periods[periodIndex]];
      var nextLevel=periodLevels[periods[periodIndex+1]];
      if(!firstLevel||!nextLevel)continue;
      var segment=document.createElementNS("http://www.w3.org/2000/svg","line");
      segment.setAttribute("class","progress-segment");
      segment.setAttribute("x1",String(xPositions[periodIndex]));
      segment.setAttribute("x2",String(xPositions[periodIndex+1]));
      segment.setAttribute("y1",String(64-philIriReadingLevelIndex(firstLevel.level)*16));
      segment.setAttribute("y2",String(64-philIriReadingLevelIndex(nextLevel.level)*16));
      chart.appendChild(segment);
    }
    periods.forEach(function(period,index){
      var result=periodLevels[period];
      if(!result)return;
      var levelIndex=philIriReadingLevelIndex(result.level);
      var point=document.createElementNS("http://www.w3.org/2000/svg","circle");
      point.setAttribute("class","progress-point");
      point.setAttribute("cx",String(xPositions[index]));
      point.setAttribute("cy",String(64-levelIndex*16));
      point.setAttribute("r","5");
      point.setAttribute("fill",colors[levelIndex]);
      var pointTitle=document.createElementNS("http://www.w3.org/2000/svg","title");
      pointTitle.textContent=period+": "+result.level+" ("+result.assessmentType+")";
      point.appendChild(pointTitle);
      chart.appendChild(point);
    });
    cell.appendChild(chart);
    var summary=document.createElement("div");
    summary.className="philiri-level-summary";
    periods.forEach(function(period){
      var result=periodLevels[period];
      var badge=document.createElement("span");
      badge.className="philiri-cycle-level "+(result?philIriReadingLevelClass(result.level):"");
      badge.textContent=period+": "+(result?result.level:"—");
      if(result)badge.title=result.assessmentType+" reading level";
      summary.appendChild(badge);
    });
    cell.appendChild(summary);
  }

  async function loadPhilIriReadingSummary(){
    var requestId=++philIriReadingSummaryRequestId;
    var table=$("philIriReadingSummaryTable");
    var empty=$("philIriReadingSummaryEmpty");
    var rows=$("philIriReadingSummaryRows");
    var notice=$("philIriReadingSummaryNotice");
    table.hidden=true;
    empty.hidden=true;
    rows.replaceChildren();
    notice.textContent="Loading reading-level progress...";
    notice.classList.remove("error");
    try{
      var periods=["BOSY","MOSY","EOSY"];
      var assessmentTypes=["Pretest","Posttest"];
      var requests=[];
      periods.forEach(function(period){
        assessmentTypes.forEach(function(assessmentType){
          var query=new URLSearchParams({period:period,assessmentType:assessmentType});
          requests.push(api("/api/phil-iri/assessments?"+query.toString()));
        });
      });
      var reports=await Promise.all(requests);
      if(requestId!==philIriReadingSummaryRequestId)return true;
      var studentsById=new Map();
      filterStudentsForActiveSection(reports[0].students).forEach(function(student){
        studentsById.set(student.id,{
          student:student,
          levels:{
            English:{},
            Filipino:{}
          }
        });
      });
      reports.forEach(function(report){
        filterStudentsForActiveSection(report.students).forEach(function(student){
          var item=studentsById.get(student.id);
          if(!item)return;
          READING_LANGUAGES_LOCAL.forEach(function(language){
            var entry=student.reading&&student.reading[language];
            var score=entry&&entry.data&&entry.data.autoScoring;
            var level=score&&score.readingLevel||entry&&entry.readingLevel;
            if(philIriReadingLevelIndex(level)<0)return;
            var current=item.levels[language][report.period];
            if(current&&current.assessmentType==="Posttest")return;
            item.levels[language][report.period]={
              level:level,
              assessmentType:report.assessmentType
            };
          });
        });
      });
      studentsById.forEach(function(item){
        var row=document.createElement("tr");
        appendTextCell(row,item.student.name);
        appendTextCell(row,item.student.lrn||"—");
        ["English","Filipino"].forEach(function(language){
          var cell=document.createElement("td");
          cell.className="philiri-progress-cell";
          renderPhilIriReadingProgress(cell,item.levels[language],item.student.name,language);
          row.appendChild(cell);
        });
        rows.appendChild(row);
      });
      table.hidden=studentsById.size===0;
      empty.hidden=studentsById.size!==0;
      var learnersWithLevels=Array.from(studentsById.values()).filter(function(item){
        return READING_LANGUAGES_LOCAL.some(function(language){
          return Object.keys(item.levels[language]).length>0;
        });
      }).length;
      notice.textContent=studentsById.size
        ?studentsById.size+" pupil"+(studentsById.size===1?"":"s")+" shown; "+learnersWithLevels+" with saved reading levels."
        :"";
      return true;
    }catch(error){
      if(requestId!==philIriReadingSummaryRequestId)return true;
      notice.textContent=error.message;
      notice.classList.add("error");
      return false;
    }
  }

  async function loadGradeSummary(){
    $("gradeSummaryNotice").textContent="";
    $("gradeSummaryNotice").classList.remove("error");
    $("gradeSummaryCount").textContent="Loading grades...";
    $("exportGradeSummary").disabled=true;
    $("gradeSummaryRows").textContent="";
    $("gradeSummaryHead").textContent="";
    $("gradeSummaryTable").hidden=true;
    $("gradeSummaryEmpty").hidden=true;
    try{
      gradeSummaryData=await api("/api/grades/summary");
      renderGradeSummary();
    }catch(error){
      $("gradeSummaryCount").textContent="Unable to load";
      $("gradeSummaryNotice").textContent=error.message;
      $("gradeSummaryNotice").classList.add("error");
    }
  }

  function renderGradeSummary(){
    var result=Object.assign({},gradeSummaryData,{
      students:filterStudentsForActiveSection(gradeSummaryData.students)
    });
    var term=$("gradeSummaryTerm").value;
    $("gradeSummaryTermTitle").textContent=term;
    $("gradeSummaryCount").textContent=result.students.length+" student"+(result.students.length===1?"":"s");
    $("exportGradeSummary").disabled=result.students.length===0;
    $("gradeSummaryEmpty").hidden=result.students.length!==0;
    $("gradeSummaryTable").hidden=result.students.length===0;
    $("gradeSummaryRows").textContent="";
    if(!result.students.length)return;
    var columns=result.subjects.map(function(subject){return[subject.key,subject.label]});
    var header=document.createElement("tr");
    [["#","summary-index"],["Name of Learners","summary-learner"]]
      .concat(columns.map(function(column){return[column[1],""]}))
      .concat([["AVERAGE","summary-average"]])
      .forEach(function(item){
        var cell=document.createElement("th");
        cell.scope="col";
        cell.className=item[1];
        cell.textContent=item[0];
        header.appendChild(cell);
      });
    $("gradeSummaryHead").replaceChildren(header);
    result.students.forEach(function(student,index){
      var row=document.createElement("tr");
      var indexCell=document.createElement("td");
      indexCell.className="summary-index";
      indexCell.textContent=String(index+1)+".";
      row.appendChild(indexCell);
      appendTextCell(row,student.name);
      row.lastElementChild.classList.add("summary-learner");
      columns.forEach(function(column){
        var grade=student.grades[term][column[0]];
        appendTextCell(row,grade===""?"—":String(grade));
      });
      var coreGrades=gradeSummaryData.generalAverageSubjects
        .map(function(key){return student.grades[term][key]});
      var average=coreGrades.every(function(grade){return typeof grade==="number"})
        ?Math.round(coreGrades.reduce(function(total,grade){return total+grade},0)/coreGrades.length)
        :null;
      appendTextCell(row,average===null?"—":average.toFixed(2));
      row.lastElementChild.classList.add("summary-average");
      var interpretation=average===null?null:getGradeInterpretation(average);
      if(interpretation){
        var descriptor=document.createElement("small");
        descriptor.className="grade-descriptor";
        descriptor.textContent=interpretation.label+" ("+interpretation.range+") — "+interpretation.description;
        row.lastElementChild.append(descriptor);
      }
      $("gradeSummaryRows").appendChild(row);
    });
  }

  function philIriSelectedStudent(){
    if(!philIriData)return null;
    return philIriData.students.find(function(student){return student.id===$("philIriLearner").value})||null;
  }

  function philIriSelectedReading(){
    var student=philIriSelectedStudent();
    return student?student.reading[$("philIriLanguage").value]||{}:null;
  }

  function philIriClassCutoff(grade,language){
    var cutoffs=philIriSettings&&philIriSettings.cutoffs;
    var value=cutoffs&&cutoffs[grade]&&cutoffs[grade][language];
    return typeof value==="number"&&Number.isFinite(value)?value:null;
  }

  function philIriLevelFor(student,language){
    var entry=student&&student.reading&&student.reading[language];
    if(!entry)return"";
    var details=entry.data&&entry.data.individualized||{};
    return details["Oral Reading"]&&details["Oral Reading"].readingLevel
      ||details["Silent Reading"]&&details["Silent Reading"].readingLevel
      ||entry.readingLevel||"";
  }

  function renderPhilIriLearners(){
    if(!philIriData)return;
    var query=$("philIriLearnerSearch").value.trim().toLowerCase();
    var previous=$("philIriLearner").value;
    var students=filterStudentsForActiveSection(philIriData.students).filter(function(student){
      return !query||student.name.toLowerCase().includes(query)||student.lrn.toLowerCase().includes(query);
    });
    $("philIriLearner").replaceChildren();
    students.forEach(function(student){
      $("philIriLearner").add(new Option(student.name+" — "+student.lrn,student.id));
    });
    if(students.some(function(student){return student.id===previous}))$("philIriLearner").value=previous;
    if(!students.length){
      $("philIriLearner").add(new Option(query?"No matching learners":"No learners in this class",""));
    }
    updatePhilIriEntry();
  }

  function updatePhilIriGstPreview(){
    var scoreText=$("philIriGstScore").value;
    var totalText=$("philIriGstTotal").value;
    var preview=$("philIriGstPreview");
    preview.replaceChildren();
    var grade=philIriData&&philIriData.profile.grade||"";
    var cutoff=philIriClassCutoff(grade,$("philIriLanguage").value);
    if(cutoff===null){
      preview.textContent="Configure the "+(grade||"class")+" GST cutoff in GST Cutoff Settings before recording results.";
      $("philIriIndividualCard").hidden=true;
      return;
    }
    var cutoffLabel=document.createElement("span");
    cutoffLabel.textContent="Passing score: "+cutoff;
    preview.append(cutoffLabel);
    var score=Number(scoreText),total=Number(totalText);
    if(scoreText===""||totalText===""||!Number.isFinite(score)||!Number.isFinite(total)||total<=0||score<0||score>total){
      $("philIriIndividualCard").hidden=true;
      return;
    }
    var percentage=document.createElement("span");
    percentage.textContent="GST percentage: "+(score/total*100).toFixed(2)+"%";
    var pass=document.createElement("span");
    var passed=score>=cutoff;
    pass.textContent=passed?"Passed GST":"Failed GST — Individualized Assessment required";
    preview.append(percentage,pass);
    $("philIriIndividualCard").hidden=passed;
    $("philIriIndividualReason").textContent=passed
      ?"The learner passed the configured GST cutoff."
      :"The learner did not reach the configured GST passing score and must receive an individualized assessment.";
  }

  function updatePhilIriIndividualPreview(){
    var values={
      words:Number($("philIriWords").value),
      miscues:Number($("philIriMiscues").value),
      seconds:Number($("philIriSeconds").value),
      correct:Number($("philIriCorrectAnswers").value),
      questions:Number($("philIriQuestions").value)
    };
    var raw=[$("philIriWords").value,$("philIriMiscues").value,$("philIriSeconds").value,
      $("philIriCorrectAnswers").value,$("philIriQuestions").value];
    var preview=$("philIriIndividualPreview");
    preview.replaceChildren();
    if(raw.some(function(value){return value===""})||values.words<1||values.miscues>values.words
      ||values.seconds<1||values.questions<1||values.correct>values.questions)return;
    var accuracy=(values.words-values.miscues)/values.words*100;
    var comprehension=values.correct/values.questions*100;
    var wpm=values.words/(values.seconds/60);
    var mode=$("philIriMode").value;
    var level=mode==="Silent Reading"
      ?comprehension>=80?"Independent":comprehension<=58?"Frustration":"Instructional"
      :accuracy>=97&&comprehension>=80?"Independent":accuracy<=89||comprehension<=58?"Frustration":"Instructional";
    [
      "WPM: "+wpm.toFixed(2),
      "Accuracy: "+accuracy.toFixed(2)+"%",
      "Comprehension: "+comprehension.toFixed(2)+"%",
      "Reading level: "+level
    ].forEach(function(text){
      var item=document.createElement("span");
      item.textContent=text;
      preview.append(item);
    });
    if(!$("philIriIntervention").value){
      $("philIriIntervention").value=level==="Frustration"?"One-on-One Reading"
        :level==="Instructional"?"Guided Reading":"Home Reading Program";
    }
  }

  async function exportGradeSummary(){
    var button=$("exportGradeSummary");
    button.disabled=true;
    $("gradeSummaryNotice").textContent="";
    $("gradeSummaryNotice").classList.remove("error");
    try{
      var exportQuery=activeStudentSection==="__all__"?""
        :"?section="+encodeURIComponent(activeStudentSection);
      var response=await fetch("/api/grades/summary/export"+exportQuery,{
        credentials:"same-origin"
      });
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to export the grading sheet.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var filenameMatch=disposition.match(/filename="([^"]+)"/i);
      if(!filenameMatch)throw new Error("The server did not provide a grading sheet filename.");
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=filenameMatch[1];
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      $("gradeSummaryNotice").textContent="Full-year grading sheet export started with all three terms.";
    }catch(error){
      $("gradeSummaryNotice").textContent=error.message;
      $("gradeSummaryNotice").classList.add("error");
    }finally{
      button.disabled=!gradeSummaryData
        ||filterStudentsForActiveSection(gradeSummaryData.students).length===0;
    }
  }

  function loadPhilIriEntry(){
    var student=philIriSelectedStudent();
    var entry=philIriSelectedReading();
    var data=entry&&entry.data||{};
    var gst=data.gst||{};
    var mode=$("philIriMode").value;
    var individualized=data.individualized&&data.individualized[mode]||{};
    $("philIriGstScore").value=gst.score===undefined?"":gst.score;
    $("philIriGstTotal").value=gst.totalItems===undefined?"":gst.totalItems;
    $("philIriPassage").value=individualized.passage||"";
    $("philIriWords").value=individualized.totalWords===undefined?"":individualized.totalWords;
    $("philIriMiscues").value=individualized.miscues===undefined?"":individualized.miscues;
    $("philIriSeconds").value=individualized.timeSeconds===undefined?"":individualized.timeSeconds;
    $("philIriCorrectAnswers").value=individualized.correctAnswers===undefined?"":individualized.correctAnswers;
    $("philIriQuestions").value=individualized.totalQuestions===undefined?"":individualized.totalQuestions;
    var intervention=data.intervention||individualized;
    $("philIriDifficulty").value=intervention.difficultyObserved||"";
    $("philIriIntervention").value=intervention.recommendedIntervention||"";
    $("philIriInterventionStart").value=intervention.interventionStartDate||"";
    $("philIriInterventionEnd").value=intervention.interventionEndDate||"";
    $("philIriProgressNotes").value=intervention.progressNotes||"";
    $("philIriRemarks").value=intervention.teacherRemarks||"";
    $("philIriRecordNotice").textContent="";
    $("philIriExistingResult").textContent=entry&&entry.assessedDate
      ?"Saved "+($("philIriType").value||"")+" on "+entry.assessedDate
        +(data.assessor?" by "+data.assessor:"")+"."
      :student?"No "+$("philIriType").value.toLowerCase()+" results saved for this learner and language yet."
        :"Select a learner to record an assessment.";
    updatePhilIriGstPreview();
    updatePhilIriIndividualPreview();
  }

  async function loadPhilIriSettings(){
    $("philIriSettingsNotice").textContent="";
    try{
      var result=await api("/api/phil-iri/settings");
      philIriSettings=result;
      var rows=$("philIriCutoffRows");
      rows.replaceChildren();
      result.grades.forEach(function(grade){
        var row=document.createElement("tr");
        var label=document.createElement("th");
        label.scope="row";
        label.textContent=grade;
        row.append(label);
        result.languages.forEach(function(language){
          var cell=document.createElement("td");
          var input=document.createElement("input");
          input.type="number";
          input.min="0";
          input.step="1";
          input.max="10000";
          input.inputMode="numeric";
          input.setAttribute("aria-label",grade+" "+language+" GST passing score");
          input.dataset.grade=grade;
          input.dataset.language=language;
          input.value=result.cutoffs[grade][language];
          cell.append(input);
          row.append(cell);
        });
        rows.append(row);
      });
      var intervention=$("philIriIntervention");
      var selectedIntervention=intervention.value;
      intervention.replaceChildren(new Option("Select intervention",""));
      result.interventions.forEach(function(value){intervention.add(new Option(value,value))});
      if(result.interventions.includes(selectedIntervention))intervention.value=selectedIntervention;
      if(currentUser&&currentUser.name&&!$("philIriAssessor").value)$("philIriAssessor").value=currentUser.name;
      if(!$("philIriDate").value)$("philIriDate").value=localISODate();
      $("philIriSchoolDescription").textContent=result.profile.schoolId
        ?"School ID "+result.profile.schoolId+" · "+(result.profile.schoolName||"School name not set")+". Results are combined only across classes with this School ID."
        :"Add your School ID to Teacher Profile to unlock school consolidated reports.";
      if(philIriData)updatePhilIriGstPreview();
    }catch(error){
      $("philIriSettingsNotice").textContent=error.message;
      $("philIriSettingsNotice").classList.add("error");
    }
  }

  async function savePhilIriCutoffs(){
    var cutoffs={};
    var inputs=$("philIriCutoffRows").querySelectorAll("input");
    var invalid=Array.from(inputs).find(function(input){return input.value===""||!Number.isInteger(Number(input.value))});
    if(invalid){
      $("philIriSettingsNotice").textContent="Enter a whole-number GST passing score for each grade and language.";
      $("philIriSettingsNotice").classList.add("error");
      invalid.focus();
      return;
    }
    inputs.forEach(function(input){
      cutoffs[input.dataset.grade]=cutoffs[input.dataset.grade]||{};
      cutoffs[input.dataset.grade][input.dataset.language]=Number(input.value);
    });
    var button=$("philIriSaveCutoffs");
    button.disabled=true;
    button.textContent="Saving...";
    $("philIriSettingsNotice").textContent="";
    $("philIriSettingsNotice").classList.remove("error");
    try{
      await api("/api/phil-iri/settings",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({cutoffs:cutoffs})
      });
      $("philIriSettingsNotice").textContent="GST cutoff settings saved for this class.";
      await loadPhilIriSettings();
      if(philIriData)updatePhilIriGstPreview();
    }catch(error){
      $("philIriSettingsNotice").textContent=error.message;
      $("philIriSettingsNotice").classList.add("error");
    }finally{
      button.disabled=false;
      button.textContent="Save GST Cutoffs";
    }
  }

  var READING_LANGUAGES_LOCAL=["English","Filipino"];
  function philIriPreferredLevel(student){
    var levels=READING_LANGUAGES_LOCAL.map(function(language){return philIriLevelFor(student,language)})
      .filter(Boolean);
    return levels.includes("Frustration")?"Frustration"
      :levels.includes("Instructional")?"Instructional"
        :levels.includes("Independent")?"Independent":"";
  }

  function philIriRenderMetrics(students,prefix){
    var assessed=students.filter(function(student){
      return READING_LANGUAGES_LOCAL.some(function(language){
        var data=student.reading[language]&&student.reading[language].data;
        return data&&(data.gst||data.individualized||data.autoScoring);
      });
    });
    var counts={Independent:0,Instructional:0,Frustration:0};
    assessed.forEach(function(student){
      var level=philIriPreferredLevel(student);
      if(level)counts[level]+=1;
    });
    $(prefix+"AssessedMetric").textContent=String(assessed.length);
    $(prefix+"IndependentMetric").textContent=String(counts.Independent);
    $(prefix+"InstructionalMetric").textContent=String(counts.Instructional);
    $(prefix+"FrustrationMetric").textContent=String(counts.Frustration);
    return counts;
  }

  function philIriRenderChart(containerId,students,groupByClass){
    var container=$(containerId);
    container.replaceChildren();
    var groups=new Map();
    students.forEach(function(student){
      READING_LANGUAGES_LOCAL.forEach(function(language){
        var level=philIriLevelFor(student,language);
        if(!level)return;
        var key=groupByClass
          ?student.grade+" · "+student.section+" · "+language
          :language;
        var counts=groups.get(key)||{Independent:0,Instructional:0,Frustration:0};
        counts[level]=(counts[level]||0)+1;
        groups.set(key,counts);
      });
    });
    var colors={Independent:"#16803c",Instructional:"#eab308",Frustration:"#b42318"};
    if(!groups.size){
      container.textContent="No individualized reading results are available yet.";
      return;
    }
    groups.forEach(function(counts,label){
      var total=counts.Independent+counts.Instructional+counts.Frustration;
      ["Independent","Instructional","Frustration"].forEach(function(level){
        var row=document.createElement("div");
        row.className="philiri-chart-row";
        var name=document.createElement("span");
        name.textContent=label+" · "+level;
        var track=document.createElement("span");
        track.className="philiri-chart-track";
        var fill=document.createElement("span");
        fill.className="philiri-chart-fill";
        fill.style.display="block";
        fill.style.width=(total?counts[level]/total*100:0)+"%";
        fill.style.background=colors[level];
        track.append(fill);
        var count=document.createElement("strong");
        count.textContent=String(counts[level]||0)+" / "+total;
        row.append(name,track,count);
        container.append(row);
      });
    });
  }

  function philIriResultText(student,language,mode){
    var reading=student.reading[language]||{};
    var individual=reading.data&&reading.data.individualized&&reading.data.individualized[mode]||{};
    return individual.readingLevel||"Not assessed";
  }

  var philIriClassReportTimer=0;
  function schedulePhilIriClassReport(){
    window.clearTimeout(philIriClassReportTimer);
    philIriClassReportTimer=window.setTimeout(function(){
      philIriClassReportTimer=0;
      renderPhilIriClassReport();
    },180);
  }

  function renderPhilIriClassReport(){
    window.clearTimeout(philIriClassReportTimer);
    philIriClassReportTimer=0;
    if(!philIriData)return;
    var search=$("philIriClassSearch").value.trim().toLowerCase();
    var gradeFilter=$("philIriGradeFilter").value;
    var sectionFilter=$("philIriSectionFilter").value;
    var levelFilter=$("philIriLevelFilter").value;
    var students=filterStudentsForActiveSection(philIriData.students).filter(function(student){
      var matchesSearch=!search||student.name.toLowerCase().includes(search)||student.lrn.toLowerCase().includes(search);
      var level=philIriPreferredLevel(student);
      return matchesSearch&&(!gradeFilter||student.grade===gradeFilter)
        &&(!sectionFilter||student.section===sectionFilter)&&(!levelFilter||level===levelFilter);
    });
    var section=$("philIriSectionFilter");
    var previous=section.value;
    var sections=Array.from(new Set(philIriData.students.map(function(student){return student.section}).filter(Boolean))).sort();
    section.replaceChildren(new Option("All sections",""));
    sections.forEach(function(value){section.add(new Option(value,value))});
    if(sections.includes(previous))section.value=previous;
    philIriRenderMetrics(students,"philIri");
    philIriRenderChart("philIriClassChart",students,false);
    var rows=$("philIriClassRows");
    rows.replaceChildren();
    students.forEach(function(student){
      READING_LANGUAGES_LOCAL.forEach(function(language){
        var result=student.reading[language]||{};
        var data=result.data||{};
        var gst=data.gst||{};
        var autoScore=data.autoScoring||{};
        var oral=data.individualized&&data.individualized["Oral Reading"]||{};
        var silent=data.individualized&&data.individualized["Silent Reading"]||{};
        var gstLabel=gst.score===undefined
          ?autoScore.gstScore===null||autoScore.gstScore===undefined?"—"
            :autoScore.gstScore+" ("+(autoScore.gstStatus||"GST scored")+")"
          :gst.score+"/"+gst.totalItems+" ("+gst.percentageScore+"%) "+(gst.passed?"Passed":"Individualized required");
        var oralLabel=oral.readingLevel
          ?oral.readingLevel+" · "+oral.accuracyPercentage+"%"
          :autoScore.oralReading===null||autoScore.oralReading===undefined?"Not assessed"
            :(autoScore.oralReading*100).toFixed(1)+"% · "+(autoScore.readingLevel||"Level pending");
        var comprehensionLabel=oral.readingLevel
          ?oral.comprehensionPercentage+"%"
          :autoScore.comprehension===null||autoScore.comprehension===undefined?"Not assessed"
            :(autoScore.comprehension*100).toFixed(1)+"%";
        var autoScoreLabel=autoScore.assessedDate
          ?[
            "GST "+(autoScore.gstScore===null||autoScore.gstScore===undefined?"—":autoScore.gstScore+" · "+(autoScore.gstStatus||"scored")),
            "Oral "+(autoScore.oralReading===null||autoScore.oralReading===undefined?"—":(autoScore.oralReading*100).toFixed(1)+"%"),
            "Comprehension "+(autoScore.comprehension===null||autoScore.comprehension===undefined?"—":(autoScore.comprehension*100).toFixed(1)+"%"),
            autoScore.readingLevel||"Level pending"
          ].join(" · ")
          :"Not recorded";
        var row=document.createElement("tr");
        [
          student.name+" · "+student.lrn,
          student.grade+" · "+student.section,
          language,
          gstLabel,
          oralLabel,
          comprehensionLabel,
          silent.readingLevel||"Not assessed",
          (data.intervention&&data.intervention.recommendedIntervention)
            ||oral.recommendedIntervention||autoScore.intervention||"—",
          autoScoreLabel
        ].forEach(function(text){appendTextCell(row,text)});
        [4,6].forEach(function(index){
          var cell=row.cells[index];
          var level=index===4?oral.readingLevel||autoScore.readingLevel:silent.readingLevel;
          if(level){
            var badge=document.createElement("span");
            badge.className="philiri-level philiri-level-"+level.toLowerCase();
            badge.textContent=level;
            cell.replaceChildren(badge);
          }
        });
        rows.append(row);
      });
    });
    var comparisonRows=$("philIriComparisonRows");
    comparisonRows.replaceChildren();
    if(!philIriComparisonData){
      $("philIriClassNotice").textContent="Loading the Pretest/Posttest comparison...";
      return;
    }
    $("philIriClassNotice").textContent="";
    var pretest=philIriData.assessmentType==="Pretest"?philIriData:philIriComparisonData;
    var posttest=philIriData.assessmentType==="Posttest"?philIriData:philIriComparisonData;
    students.forEach(function(student){
      READING_LANGUAGES_LOCAL.forEach(function(language){
        var preStudent=pretest.students.find(function(candidate){return candidate.id===student.id});
        var postStudent=posttest.students.find(function(candidate){return candidate.id===student.id});
        var preLevel=philIriLevelFor(preStudent,language)||"Not assessed";
        var postLevel=philIriLevelFor(postStudent,language)||"Not assessed";
        var preRank=PHILIRI_LEVEL_ORDER[preLevel];
        var postRank=PHILIRI_LEVEL_ORDER[postLevel];
        var progress=preRank===undefined||postRank===undefined?"Insufficient results"
          :postRank>preRank?"Improved":postRank===preRank?"Maintained":"Needs follow-up";
        var postReading=postStudent&&postStudent.reading[language];
        var preReading=preStudent&&preStudent.reading[language];
        var intervention=postReading&&postReading.data&&postReading.data.intervention
          ||preReading&&preReading.data&&preReading.data.intervention||{};
        var row=document.createElement("tr");
        [student.name+" · "+student.lrn,language,preLevel,postLevel,
          intervention.recommendedIntervention||"—",progress]
          .forEach(function(text){appendTextCell(row,text)});
        comparisonRows.append(row);
      });
    });
  }

  var PHILIRI_LEVEL_ORDER={Frustration:0,Instructional:1,Independent:2};

  async function loadPhilIriReports(){
    var requestId=++philIriRequestId;
    $("philIriClassNotice").textContent="";
    $("philIriClassNotice").classList.remove("error");
    try{
      var period=$("philIriPeriod").value;
      var type=$("philIriType").value;
      var query="?period="+encodeURIComponent(period)+"&assessmentType="+encodeURIComponent(type);
      var current=await api("/api/phil-iri/assessments"+query);
      var otherQuery="?period="+encodeURIComponent(period)+"&assessmentType="+encodeURIComponent(type==="Pretest"?"Posttest":"Pretest");
      var other=await api("/api/phil-iri/assessments"+otherQuery);
      if(requestId!==philIriRequestId)return;
      if(current.assessmentType!==type||current.period!==period)throw new Error("The server returned PHIL-IRI results for a different assessment.");
      philIriData=current;
      philIriComparisonData=other;
      $("philIriPrintMeta").textContent=[current.profile.schoolName,current.profile.schoolId,current.profile.schoolYear,
        current.profile.grade,current.profile.section,period,type].filter(Boolean).join(" · ");
      if(!philIriSettings)await loadPhilIriSettings();
      renderPhilIriLearners();
      renderPhilIriClassReport();
    }catch(error){
      if(requestId!==philIriRequestId)return;
      $("philIriRecordNotice").textContent=error.message;
      $("philIriRecordNotice").classList.add("error");
      $("philIriClassNotice").textContent=error.message;
      $("philIriClassNotice").classList.add("error");
    }
  }

  async function loadPhilIriSchoolReport(){
    $("philIriSchoolNotice").textContent="";
    $("philIriSchoolNotice").classList.remove("error");
    try{
      var query="?scope=school&period="+encodeURIComponent($("philIriPeriod").value)
        +"&assessmentType="+encodeURIComponent($("philIriType").value);
      var report=await api("/api/phil-iri/assessments"+query);
      philIriSchoolData=report;
      philIriRenderMetrics(report.students,"philIriSchool");
      philIriRenderChart("philIriSchoolChart",report.students,true);
      var grouped=new Map();
      report.students.forEach(function(student){
        READING_LANGUAGES_LOCAL.forEach(function(language){
          var level=philIriLevelFor(student,language);
          if(!level)return;
          var key=[student.grade,student.section,language].join("\u0000");
          var counts=grouped.get(key)||{Independent:0,Instructional:0,Frustration:0};
          counts[level]+=1;
          grouped.set(key,counts);
        });
      });
      var rows=$("philIriSchoolRows");
      rows.replaceChildren();
      grouped.forEach(function(counts,key){
        var row=document.createElement("tr");
        [key.split("\u0000")[0],key.split("\u0000")[1],key.split("\u0000")[2],
          counts.Independent,counts.Instructional,counts.Frustration]
          .forEach(function(value){appendTextCell(row,String(value))});
        rows.append(row);
      });
    }catch(error){
      $("philIriSchoolNotice").textContent=error.message;
      $("philIriSchoolNotice").classList.add("error");
    }
  }

  function updatePhilIriEntry(){
    if(!philIriData)return;
    var student=philIriSelectedStudent();
    var entry=philIriSelectedReading();
    var data=entry&&entry.data||{};
    $("philIriDate").value=data.assessedDate||$("philIriDate").value||localISODate();
    $("philIriAssessor").value=data.assessor||$("philIriAssessor").value||currentUser&&currentUser.name||"";
    $("philIriExistingResult").textContent=entry&&entry.assessedDate
      ?"Saved "+$("philIriType").value+" on "+entry.assessedDate+(data.assessor?" by "+data.assessor:"")+"."
      :student?"No "+$("philIriType").value.toLowerCase()+" results saved for this learner and language yet."
        :"Select a learner to record an assessment.";
    loadPhilIriEntry();
  }

  function schedulePhilIriAutosave(stage){
    if(philIriAutosaveTimer)window.clearTimeout(philIriAutosaveTimer);
    var required=stage==="GST"
      ?$("philIriGstScore").value!==""&&$("philIriGstTotal").value!==""
      :$("philIriWords").value!==""&&$("philIriMiscues").value!==""&&$("philIriSeconds").value!==""
        &&$("philIriCorrectAnswers").value!==""&&$("philIriQuestions").value!=="";
    if(!required)return;
    $("philIriRecordNotice").classList.remove("error");
    $("philIriRecordNotice").textContent="Changes will save automatically...";
    var body=philIriAssessmentPayload(stage);
    philIriAutosaveTimer=window.setTimeout(function(){savePhilIriAssessment(stage,true,body)},1000);
  }

  function philIriAssessmentPayload(stage){
    var student=philIriSelectedStudent();
    if(!student)return null;
    var body={
      studentId:student.id,
      period:$("philIriPeriod").value,
      assessmentType:$("philIriType").value,
      language:$("philIriLanguage").value,
      stage:stage,
      assessedDate:$("philIriDate").value,
      assessor:$("philIriAssessor").value
    };
    if(stage==="GST"){
      body.gstScore=Number($("philIriGstScore").value);
      body.gstTotalItems=Number($("philIriGstTotal").value);
    }else{
      body.readingMode=$("philIriMode").value;
      body.passage=$("philIriPassage").value;
      body.totalWords=Number($("philIriWords").value);
      body.miscues=Number($("philIriMiscues").value);
      body.timeSeconds=Number($("philIriSeconds").value);
      body.correctAnswers=Number($("philIriCorrectAnswers").value);
      body.totalQuestions=Number($("philIriQuestions").value);
      body.difficultyObserved=$("philIriDifficulty").value;
      body.recommendedIntervention=$("philIriIntervention").value;
      body.interventionStartDate=$("philIriInterventionStart").value;
      body.interventionEndDate=$("philIriInterventionEnd").value;
      body.progressNotes=$("philIriProgressNotes").value;
      body.teacherRemarks=$("philIriRemarks").value;
    }
    return body;
  }

  async function savePhilIriAssessment(stage,autoSave,bodyOverride){
    if(philIriSaving){
      if(autoSave)window.setTimeout(function(){savePhilIriAssessment(stage,true,bodyOverride)},500);
      return;
    }
    var body=bodyOverride||philIriAssessmentPayload(stage);
    if(!body){
      if(!autoSave)$("philIriRecordNotice").textContent="Select a learner from your class roster.";
      return;
    }
    if(!autoSave&&philIriAutosaveTimer){
      window.clearTimeout(philIriAutosaveTimer);
      philIriAutosaveTimer=null;
    }
    philIriSaving=true;
    var button=stage==="GST"?$("philIriSaveGst"):$("philIriSaveIndividual");
    $("philIriSaveGst").disabled=true;
    $("philIriSaveIndividual").disabled=true;
    if(!autoSave)button.textContent="Saving...";
    $("philIriRecordNotice").textContent=autoSave?"Saving assessment changes...":"";
    $("philIriRecordNotice").classList.remove("error");
    try{
      var saved=await api("/api/phil-iri/assessments",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body)
      });
      if(philIriData&&philIriData.period===saved.period&&philIriData.assessmentType===saved.assessmentType){
        var savedStudent=philIriData.students.find(function(entry){return entry.id===saved.studentId});
        if(savedStudent){
          var result=savedStudent.reading[saved.language]||{};
          result.data=saved.data;
          result.readingLevel=saved.readingLevel;
          result.assessedDate=saved.data.assessedDate;
          savedStudent.reading[saved.language]=result;
        }
      }
      var currentContext=body.period===$("philIriPeriod").value&&body.assessmentType===$("philIriType").value
        &&body.language===$("philIriLanguage").value&&body.studentId===$("philIriLearner").value;
      if(currentContext){
        $("philIriExistingResult").textContent="Saved "+saved.assessmentType+" on "+saved.data.assessedDate+" by "+saved.data.assessor+".";
        $("philIriRecordNotice").textContent=autoSave?"Assessment auto-saved.":"Assessment saved.";
        updatePhilIriGstPreview();
        updatePhilIriIndividualPreview();
      }
      renderPhilIriClassReport();
    }catch(error){
      var stillCurrent=body.period===$("philIriPeriod").value&&body.assessmentType===$("philIriType").value
        &&body.language===$("philIriLanguage").value&&body.studentId===$("philIriLearner").value;
      if(stillCurrent){
        $("philIriRecordNotice").textContent=error.message;
        $("philIriRecordNotice").classList.add("error");
      }
    }finally{
      philIriSaving=false;
      $("philIriSaveGst").disabled=false;
      $("philIriSaveIndividual").disabled=false;
      if(!autoSave)button.textContent=stage==="GST"?"Save GST Results":"Save Individualized Assessment";
    }
  }

  function setPhilIriTab(tabId){
    ["philIriRecordTab","philIriClassTab","philIriSettingsTab","philIriSchoolTab"].forEach(function(id){
      $(id).setAttribute("aria-selected",String(id===tabId));
      var panelId=$(id).getAttribute("aria-controls");
      $(panelId).hidden=id!==tabId;
    });
    if(tabId==="philIriClassTab")loadPhilIriReports();
    if(tabId==="philIriSettingsTab")loadPhilIriSettings();
    if(tabId==="philIriSchoolTab")loadPhilIriSchoolReport();
  }

  async function downloadPhilIriReport(scope,studentId){
    var params=new URLSearchParams({
      scope:scope,
      period:$("philIriPeriod").value,
      assessmentType:$("philIriType").value,
    });
    if(studentId)params.set("studentId",studentId);
    if(scope!=="school"&&activeStudentSection!=="__all__"){
      params.set("section",activeStudentSection);
    }
    var status=scope==="school"?$("philIriSchoolNotice"):scope==="class"?$("philIriClassNotice"):$("philIriRecordNotice");
    var button=scope==="school"?$("philIriExportSchool"):scope==="class"?$("philIriExportClass"):$("philIriExportStudent");
    button.disabled=true;
    status.textContent="";
    status.classList.remove("error");
    try{
      var response=await fetch("/api/phil-iri/export?"+params.toString());
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to export PHIL-IRI results.");
      }

      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download="PHIL-IRI_"+scope+"_"+params.get("period")+"_"+params.get("assessmentType")+".xlsx";
      link.style.display="none";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      status.textContent="PHIL-IRI Excel report download started.";
    }catch(error){
      status.textContent=error.message;
      status.classList.add("error");
    }finally{
      button.disabled=false;
    }
  }

  async function downloadPhilIriForm(form){
    var params=new URLSearchParams({
      form:form,
      period:$("philIriResultsCycle").value,
      assessmentType:$("philIriResultsType").value,
    });
    if(activeStudentSection!=="__all__")params.set("section",activeStudentSection);
    var notice=$("philIriResultsNotice");
    var button=$("philIriDownloadReport");
    button.disabled=true;
    notice.textContent="";
    notice.classList.remove("error");
    try{
      var response=await fetch("/api/phil-iri/forms?"+params.toString());
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to download the Phil-IRI form.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var match=disposition.match(/filename="([^"]+)"/i);
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=match?match[1]:"PhilIRI_Form_"+form+".xlsx";
      link.style.display="none";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      notice.textContent="Phil-IRI Form "+form+" download started.";
    }catch(error){
      notice.textContent=error.message;
      notice.classList.add("error");
    }finally{
      button.disabled=false;
    }
  }

  function renderPhilIriIndividualPrint(){
    var student=philIriSelectedStudent();
    var entry=philIriSelectedReading();
    var report=$("philIriIndividualPrint");
    report.replaceChildren();
    var heading=document.createElement("h2");
    heading.textContent=student?student.name+" — Individual Learner Report":"Individual Learner Report";
    report.append(heading);
    if(!student||!entry||!entry.assessedDate){
      var empty=document.createElement("p");
      empty.textContent="No saved PHIL-IRI results are available for the selected learner, cycle, assessment type, and language.";
      report.append(empty);
      return;
    }
    var summary=document.createElement("p");
    summary.textContent=[student.lrn,student.grade,student.section,$("philIriLanguage").value,
      $("philIriPeriod").value,$("philIriType").value,entry.assessedDate,
      entry.data.assessor&&"Assessor: "+entry.data.assessor].filter(Boolean).join(" · ");
    report.append(summary);
    var data=entry.data||{};
    var gst=data.gst||{};
    var gstHeading=document.createElement("h3");
    gstHeading.textContent="Group Screening Test";
    var gstResult=document.createElement("p");
    gstResult.textContent=gst.score===undefined?"No GST result saved."
      :"Score: "+gst.score+"/"+gst.totalItems+" ("+gst.percentageScore+"%) · Passing score: "+gst.passingScore
        +" · "+(gst.passed?"Passed":"Failed — individualized assessment required");
    report.append(gstHeading,gstResult);
    ["Oral Reading","Silent Reading"].forEach(function(mode){
      var result=data.individualized&&data.individualized[mode];
      if(!result)return;
      var modeHeading=document.createElement("h3");
      modeHeading.textContent=mode;
      var modeResult=document.createElement("p");
      modeResult.textContent=[
        "Passage: "+(result.passage||"Not recorded"),
        "WPM: "+result.wordsPerMinute,
        "Accuracy: "+result.accuracyPercentage+"%",
        "Comprehension: "+result.comprehensionPercentage+"%",
        "Level: "+result.readingLevel
      ].join(" · ");
      report.append(modeHeading,modeResult);
    });
    var intervention=data.intervention||{};
    var notes=document.createElement("p");
    notes.textContent=[
      "Difficulty: "+(intervention.difficultyObserved||"Not recorded"),
      "Intervention: "+(intervention.recommendedIntervention||"Not recorded"),
      "Intervention dates: "+[intervention.interventionStartDate,intervention.interventionEndDate].filter(Boolean).join(" to "),
      "Progress: "+(intervention.progressNotes||"Not recorded"),
      "Remarks: "+(intervention.teacherRemarks||"Not recorded")
    ].join(" · ");
    report.append(notes);
  }

  function printPhilIriReport(){
    if($("philIriRecordTab").getAttribute("aria-selected")==="true"){
      renderPhilIriIndividualPrint();
      $("philIriIndividualPrint").hidden=false;
    }
    $("readingProgressPage").hidden=false;
    document.body.classList.add("philiri-printing");
    window.print();
  }

  function renderReadingChart(containerId,language,period,students){
    var categories=["Non-reader","Frustration","Instructional","Independent"];
    var colors=["#94a3b8","#f97316","#eab308","#2f7f70"];
    var counts=categories.map(function(level){
      return students.filter(function(student){return student.levels[language]===level}).length;
    });
    var maximum=Math.max(1,...counts);
    var svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("class","reading-chart");
    svg.setAttribute("viewBox","0 0 560 230");
    svg.setAttribute("role","img");
    svg.setAttribute("aria-label",language+" "+period+" reading level counts: "+categories.map(function(level,index){return level+" "+counts[index]}).join(", "));
    var baseline=174,plotHeight=132;
    [0,0.5,1].forEach(function(ratio){
      var y=baseline-plotHeight*ratio;
      var line=document.createElementNS(svg.namespaceURI,"line");
      line.setAttribute("x1","38");line.setAttribute("x2","540");
      line.setAttribute("y1",String(y));line.setAttribute("y2",String(y));
      line.setAttribute("stroke","var(--line)");line.setAttribute("stroke-width","1");
      svg.appendChild(line);
      var tick=document.createElementNS(svg.namespaceURI,"text");
      tick.setAttribute("x","30");tick.setAttribute("y",String(y+4));tick.setAttribute("text-anchor","end");
      tick.textContent=String(Math.round(maximum*ratio));svg.appendChild(tick);
    });
    categories.forEach(function(level,index){
      var x=76+index*124;
      var height=counts[index]/maximum*plotHeight;
      var bar=document.createElementNS(svg.namespaceURI,"rect");
      bar.setAttribute("x",String(x));bar.setAttribute("y",String(baseline-height));
      bar.setAttribute("width","58");bar.setAttribute("height",String(height));
      bar.setAttribute("rx","7");bar.setAttribute("fill",colors[index]);
      svg.appendChild(bar);
      var value=document.createElementNS(svg.namespaceURI,"text");
      value.setAttribute("class","chart-value");value.setAttribute("x",String(x+29));
      value.setAttribute("y",String(Math.max(14,baseline-height-7)));value.setAttribute("text-anchor","middle");
      value.textContent=String(counts[index]);svg.appendChild(value);
      var label=document.createElementNS(svg.namespaceURI,"text");
      label.setAttribute("class","chart-category");
      label.setAttribute("x",String(x+29));label.setAttribute("y","198");label.setAttribute("text-anchor","middle");
      label.textContent=level;svg.appendChild(label);
    });
    $(containerId).replaceChildren(svg);
  }

  function renderReadingProgress(result){
    if(!result)return;
    var students=filterStudentsForActiveSection(result.students);
    var attemptLabel=formatReadingAttempt(result.attemptNo);
    $("readingReportTitle").textContent=result.period+" "+attemptLabel+" learner assessment overview";
    $("readingRecordTitle").textContent=result.period+" · "+attemptLabel+" Assessment";
    $("readingEnglishChartCaption").textContent=result.period+" "+attemptLabel+" learner count by reading level";
    $("readingFilipinoChartCaption").textContent=result.period+" "+attemptLabel+" learner count by reading level";
    var pendingLevels={};
    if(readingDirty){
      $("readingRecordRows").querySelectorAll("tr[data-student-id]").forEach(function(row){
        pendingLevels[row.dataset.studentId]=Array.from(row.querySelectorAll("select")).map(function(select){return select.value});
      });
    }
    var assessed=students.filter(function(student){
      return result.languages.some(function(language){return Boolean(student.levels[language])});
    }).length;
    var coverage=students.length?Math.round(assessed/students.length*100):0;
    $("readingRosterCount").textContent=String(students.length);
    $("readingAssessedCount").textContent=String(assessed);
    $("readingCoverage").textContent=students.length?coverage+"%":"—";
    $("readingReportCount").textContent=assessed+" of "+students.length+" assessed";
    $("readingRecordCount").textContent=students.length+" student"+(students.length===1?"":"s");
    $("readingReportEmpty").hidden=students.length!==0;
    $("readingReportTable").hidden=students.length===0;
    $("readingRecordEmpty").hidden=students.length!==0;
    $("readingRecordTable").hidden=students.length===0;
    $("readingReportRows").textContent="";
    $("readingRecordRows").textContent="";
    students.forEach(function(student){
      var reportRow=document.createElement("tr");
      appendTextCell(reportRow,student.name);
      result.languages.forEach(function(language){
        appendTextCell(reportRow,student.levels[language]||"Not assessed");
        appendTextCell(reportRow,student.assessedDates[language]||"—");
      });
      $("readingReportRows").appendChild(reportRow);

      var recordRow=document.createElement("tr");
      recordRow.dataset.studentId=student.id;
      appendTextCell(recordRow,student.name);
      result.languages.forEach(function(language){
        var cell=document.createElement("td");
        var select=document.createElement("select");
        select.className="reading-level-select";
        select.setAttribute("aria-label",language+" reading level for "+student.name);
        select.add(new Option("Not assessed",""));
        result.levels.forEach(function(level){select.add(new Option(level,level))});
        var pendingForStudent=pendingLevels[student.id];
        select.value=pendingForStudent?pendingForStudent[result.languages.indexOf(language)]:student.levels[language]||"";
        select.onchange=function(){
          recordRow.dataset.dirty=Array.from(recordRow.querySelectorAll("select")).some(function(input,index){
            return input.value!==student.levels[result.languages[index]];
          })?"true":"false";
          readingDirty=$("readingRecordRows").querySelector('tr[data-dirty="true"]')!==null;
        };
        var date=document.createElement("span");
        date.className="reading-assessed-date";
        date.textContent=student.assessedDates[language]
          ?"Assessed "+student.assessedDates[language]
          :"Date set automatically when saved";
        cell.append(select,date);recordRow.appendChild(cell);
      });
      recordRow.dataset.dirty=Array.from(recordRow.querySelectorAll("select")).some(function(select,index){
        return select.value!==student.levels[result.languages[index]];
      })?"true":"false";
      var actionCell=document.createElement("td");
      var save=document.createElement("button");
      save.className="btn reading-save";save.type="button";save.textContent="Save";
      save.dataset.studentId=student.id;
      actionCell.appendChild(save);recordRow.appendChild(actionCell);
      $("readingRecordRows").appendChild(recordRow);
    });
    readingDirty=$("readingRecordRows").querySelector('tr[data-dirty="true"]')!==null;
    renderReadingChart("readingEnglishChart","English",result.period,students);
    renderReadingChart("readingFilipinoChart","Filipino",result.period,students);
  }

  async function loadReadingProgress(){
    var requestedPeriod=readingPeriod;
    var requestId=++readingRequestId;
    $("readingNotice").textContent="";
    $("readingNotice").classList.remove("error");
    $("readingReportCount").textContent="Loading assessments...";
    $("readingRecordCount").textContent="Loading students...";
    $("readingEnglishChart").replaceChildren();
    $("readingFilipinoChart").replaceChildren();
    try{
      var result=await api("/api/reading-assessments?period="+encodeURIComponent(requestedPeriod)
        +"&attemptNo="+encodeURIComponent(readingAttempt));
      if(requestId!==readingRequestId||requestedPeriod!==readingPeriod)return;
      if(result.period!==requestedPeriod||result.attemptNo!==readingAttempt)throw new Error("The server returned assessments for a different period or attempt.");
      readingProgressData=result;
      renderReadingProgress(result);
    }catch(error){
      if(requestId!==readingRequestId)return;
      $("readingReportCount").textContent="Unable to load";
      $("readingRecordCount").textContent="Unable to load";
      $("readingNotice").textContent=error.message;
      $("readingNotice").classList.add("error");
    }
  }

  function setTeacherProfilePhoto(hasPhoto){
    $("removeTeacherPhoto").hidden=!hasPhoto;
    [
      {image:$("teacherProfilePhoto"),fallback:$("teacherProfileInitials")},
      {image:$("topProfilePhoto"),fallback:$("topProfileInitials")}
    ].forEach(function(entry){
      if(!hasPhoto){
        entry.image.hidden=true;
        entry.image.removeAttribute("src");
        entry.fallback.hidden=false;
        return;
      }
      entry.image.onload=function(){
        entry.image.hidden=false;
        entry.fallback.hidden=true;
      };
      entry.image.onerror=function(){
        entry.image.hidden=true;
        entry.fallback.hidden=false;
        $("removeTeacherPhoto").hidden=true;
      };
      entry.image.src="/api/teacher/profile/photo?version="+Date.now();
    });
  }

  function setTeacherSchoolLogo(hasLogo){
    $("removeSchoolLogo").hidden=!hasLogo;
    if(!hasLogo){
      $("teacherSchoolLogo").hidden=true;
      $("teacherSchoolLogo").removeAttribute("src");
      $("teacherSchoolLogoPlaceholder").hidden=false;
      return;
    }
    $("teacherSchoolLogo").onload=function(){
      $("teacherSchoolLogo").hidden=false;
      $("teacherSchoolLogoPlaceholder").hidden=true;
    };
    $("teacherSchoolLogo").onerror=function(){
      $("teacherSchoolLogo").hidden=true;
      $("teacherSchoolLogoPlaceholder").hidden=false;
      $("removeSchoolLogo").hidden=true;
    };
    $("teacherSchoolLogo").src="/api/teacher/profile/school-logo/preview?version="+Date.now();
  }

  async function loadTeacherProfile(){
    $("teacherProfileError").textContent="";
    $("teacherProfileNotice").textContent="";
    $("teacherProfileBasicError").textContent="";
    $("teacherProfileBasicNotice").textContent="";
    $("teacherProfileSchoolError").textContent="";
    $("teacherProfileSchoolNotice").textContent="";
    try{
      var profileResults=await Promise.all([
        api("/api/teacher/profile"),
        api("/api/teacher/profile/subjects")
      ]);
      var result=profileResults[0];
      var subjectProfile=profileResults[1];
      $("teacherProfileName").value=result.name;
      $("teacherProfilePosition").value=result.position||"";
      $("teacherProfileEmail").value=result.email;
      $("teacherProfileClassroom").value=result.classroomNumber;
      teacherProfileSavedIdentity={
        name:result.name,
        email:result.email,
        classroomNumber:result.classroomNumber
      };
      $("teacherProfileGrade").value=result.grade||"";
      $("teacherProfileSection").value=result.section||"";
      defaultStudentSection=result.section||"";
      defaultStudentGrade=result.grade||"";
      handledSections=Array.isArray(result.sectionsHandled)?result.sectionsHandled:(result.section?[result.section]:[]);
      sectionGrades=result.sectionGrades&&typeof result.sectionGrades==="object"?result.sectionGrades:{};
      handledSubjects=Array.isArray(result.subjectsHandled)?result.subjectsHandled:[];
      if(!Array.isArray(subjectProfile.availableSubjects)||!subjectProfile.availableSubjects.length){
        throw new Error("The subject list could not be loaded. Please refresh and try again.");
      }
      availableSubjects=subjectProfile.availableSubjects;
      configureGradeSubjects(subjectProfile.gradeSubjects||result.gradeSubjects);
      configureEClassSubjects(subjectProfile.eClassSubjects||result.eClassSubjects,subjectProfile.gradeSubjects||result.gradeSubjects);
      handledSections=Array.isArray(subjectProfile.sectionsHandled)?subjectProfile.sectionsHandled:handledSections;
      sectionSubjects=subjectProfile.sectionSubjects&&typeof subjectProfile.sectionSubjects==="object"
        ?subjectProfile.sectionSubjects:{};
      if(!Object.keys(sectionSubjects).length&&handledSubjects.length&&subjectProfile.advisorySection){
        sectionSubjects[subjectProfile.advisorySection]=handledSubjects;
      }
      $("teacherProfileSectionsHandled").value=handledSections.join(", ");
      syncTeacherSectionRenamePasswordField();
      teacherSubjectsLocked=true;
      teacherSubjectsDirty=false;
      populateTeacherSubjectSections(subjectProfile.advisorySection||handledSections[0]||"");
      populateSectionControls(result.section||activeStudentSection);
      renderStudents(rosterStudents);
      $("teacherProfileSchoolYear").value=result.schoolYear||"";
      $("teacherProfileFirstDayOfSchool").value=result.firstDayOfSchool||"";
      $("teacherProfileEndOfSchoolYear").value=result.endOfSchoolYear||"";
      refreshAttendanceYears();
      $("teacherProfileSchoolName").value=result.schoolName||"";
      $("teacherProfileSchoolId").value=result.schoolId||"";
      $("teacherProfileRegion").value=result.region||"";
      $("teacherProfileDivision").value=result.division||"";
      $("teacherProfileDistrict").value=result.district||"";
      $("teacherProfileSchoolHead").value=result.schoolHead||"";
      $("teacherProfileSchoolHeadPosition").value=result.schoolHeadPosition||"";
      syncEnglishLessonPlanProfileFields();
      $("teacherProfileDisplayName").textContent=result.name;
      var initials=result.name.trim().split(/\s+/).slice(0,2).map(function(part){return part.charAt(0).toUpperCase()}).join("")||"T";
      $("teacherProfileInitials").textContent=initials;
      $("topProfileInitials").textContent=initials;
      $("teacherProfileClassCode").textContent=currentUser.classCode||"Not available";
      teacherProfileDirty=false;
      teacherProfileDetailsDirty=false;
      teacherProfileBasicDirty=false;
      teacherProfileSchoolDirty=false;
      setTeacherProfilePhoto(result.hasPhoto);
      setTeacherSchoolLogo(result.hasSchoolLogo);
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }
  }

  function renderParentReadingTrend(learner){
    var chart=$("parentReadingTrendChart");
    var dateChart=$("parentReadingDateTrendChart");
    var emptyMessage=$("parentReadingTrendEmpty");
    var dateEmptyMessage=$("parentReadingDateTrendEmpty");
    var legend=$("parentReadingTrendLegend");
    chart.replaceChildren();
    dateChart.replaceChildren();
    var svgNamespace="http://www.w3.org/2000/svg";
    var periods=parentPortalData.readingPeriods;
    var languages=parentPortalData.readingLanguages;
    var levels=["Non-reader","Frustration","Instructional","Independent"];
    var plot={left:156,right:728,top:40,bottom:218};
    var xForPeriod=function(index){
      return periods.length<2?(plot.left+plot.right)/2
        :plot.left+(plot.right-plot.left)*index/(periods.length-1);
    };
    var yForLevel=function(level){
      var levelIndex=levels.indexOf(level);
      return levelIndex<0?null:plot.bottom-(plot.bottom-plot.top)*levelIndex/(levels.length-1);
    };
    var hasAssessment=periods.some(function(period){
      return languages.some(function(language){
        return levels.indexOf(learner.reading[period][language].level)!==-1;
      });
    });
    chart.hidden=!hasAssessment;
    emptyMessage.hidden=hasAssessment;
    legend.hidden=!hasAssessment;
    dateChart.hidden=true;
    dateEmptyMessage.hidden=true;
    if(!hasAssessment){
      dateEmptyMessage.hidden=false;
      return;
    }

    function svgElement(name,attributes,text){
      var element=document.createElementNS(svgNamespace,name);
      Object.keys(attributes||{}).forEach(function(attribute){
        element.setAttribute(attribute,attributes[attribute]);
      });
      if(text!==undefined)element.textContent=text;
      return element;
    }
    var chartDescription=svgElement("desc",{}, "Reading levels from Non-reader to Independent. Each period also shows the English and Filipino assessment dates.");
    chart.append(svgElement("title",{},"Reading progress from BOSY to EOSY"),chartDescription);

    levels.slice().reverse().forEach(function(level,index){
      var y=plot.top+(plot.bottom-plot.top)*index/(levels.length-1);
      chart.append(
        svgElement("line",{x1:plot.left,y1:y,x2:plot.right,y2:y,class:"parent-reading-trend-gridline"}),
        svgElement("text",{x:plot.left-12,y:y+4,"text-anchor":"end"},level)
      );
    });
    chart.append(
      svgElement("line",{x1:plot.left,y1:plot.top,x2:plot.left,y2:plot.bottom,class:"parent-reading-trend-axis"}),
      svgElement("line",{x1:plot.left,y1:plot.bottom,x2:plot.right,y2:plot.bottom,class:"parent-reading-trend-axis"})
    );
    periods.forEach(function(period,index){
      var x=xForPeriod(index);
      chart.append(
        svgElement("text",{x:x,y:plot.bottom+24,"text-anchor":"middle","font-weight":"700"},period),
        svgElement("text",{x:x,y:plot.bottom+43,"text-anchor":"middle",class:"parent-reading-date-label"},"Eng: "+formatReadingDate(learner.reading[period].English.assessedDate)),
        svgElement("text",{x:x,y:plot.bottom+59,"text-anchor":"middle",class:"parent-reading-date-label"},"Fil: "+formatReadingDate(learner.reading[period].Filipino.assessedDate))
      );
    });
    chart.setAttribute("viewBox","0 0 760 300");

    var accessibleSummary=[];
    var datedAttempts=[];
    languages.forEach(function(language){
      var points=periods.map(function(period,index){
        var result=learner.reading[period][language];
        var level=result.level;
        var y=yForLevel(level);
        if(y===null){
          accessibleSummary.push(language+" "+period+": not assessed");
          return null;
        }
        var attemptNo=result.attemptNo||1;
        accessibleSummary.push(language+" "+period+" "+formatReadingAttempt(attemptNo)+": "+level+" on "+formatReadingDate(result.assessedDate));
        (result.attempts||[]).forEach(function(attempt){
          if(yForLevel(attempt.level)===null||!parseReadingDate(attempt.assessedDate))return;
          datedAttempts.push({
            language:language,
            period:period,
            attemptNo:attempt.attemptNo||1,
            level:attempt.level,
            assessedDate:attempt.assessedDate,
            timestamp:parseReadingDate(attempt.assessedDate)
          });
        });
        return {x:xForPeriod(index),y:y,period:period,level:level,attemptNo:attemptNo,assessedDate:result.assessedDate};
      });
      points.forEach(function(point,index){
        if(!point||index===0||!points[index-1])return;
        chart.append(svgElement("line",{
          x1:points[index-1].x,y1:points[index-1].y,
          x2:point.x,y2:point.y,
          class:"parent-reading-trend-series",
          "data-language":language
        }));
      });
      points.forEach(function(point){
        if(!point)return;
        var marker=svgElement("circle",{
          cx:point.x,cy:point.y,r:7,
          class:"parent-reading-trend-point",
          "data-language":language
        });
        marker.append(svgElement("title",{},language+" - "+point.period+" "+formatReadingAttempt(point.attemptNo)+": "+point.level+" on "+formatReadingDate(point.assessedDate)));
        chart.append(marker);
      });
    });
    chart.setAttribute("aria-label","Reading progress by assessment period. "+accessibleSummary.join("; "));
    dateEmptyMessage.hidden=datedAttempts.length!==0;
    dateChart.hidden=datedAttempts.length===0;
    if(!datedAttempts.length)return;
    dateChart.setAttribute("viewBox","0 0 760 330");
    var datePlot={left:156,right:728,top:38,bottom:224};
    var firstTimestamp=Math.min.apply(null,datedAttempts.map(function(attempt){return attempt.timestamp}));
    var lastTimestamp=Math.max.apply(null,datedAttempts.map(function(attempt){return attempt.timestamp}));
    var xForDate=function(timestamp){
      return firstTimestamp===lastTimestamp?(datePlot.left+datePlot.right)/2
        :datePlot.left+(datePlot.right-datePlot.left)*(timestamp-firstTimestamp)/(lastTimestamp-firstTimestamp);
    };
    dateChart.append(
      svgElement("title",{},"Reading progress by assessment date"),
      svgElement("desc",{},"Each point shows the reading level for an English or Filipino assessment attempt on its recorded date. Points are connected in date order.")
    );
    levels.slice().reverse().forEach(function(level,index){
      var y=datePlot.top+(datePlot.bottom-datePlot.top)*index/(levels.length-1);
      dateChart.append(
        svgElement("line",{x1:datePlot.left,y1:y,x2:datePlot.right,y2:y,class:"parent-reading-date-trend-gridline"}),
        svgElement("text",{x:datePlot.left-12,y:y+4,"text-anchor":"end"},level)
      );
    });
    dateChart.append(
      svgElement("line",{x1:datePlot.left,y1:datePlot.top,x2:datePlot.left,y2:datePlot.bottom,class:"parent-reading-date-trend-axis"}),
      svgElement("line",{x1:datePlot.left,y1:datePlot.bottom,x2:datePlot.right,y2:datePlot.bottom,class:"parent-reading-date-trend-axis"})
    );
    var uniqueTimestamps=Array.from(new Set(datedAttempts.map(function(attempt){return attempt.timestamp}))).sort(function(a,b){return a-b});
    var tickCount=Math.min(5,uniqueTimestamps.length);
    for(var tickIndex=0;tickIndex<tickCount;tickIndex++){
      var timestamp=uniqueTimestamps[Math.round(tickIndex*(uniqueTimestamps.length-1)/Math.max(1,tickCount-1))];
      dateChart.append(svgElement("text",{x:xForDate(timestamp),y:datePlot.bottom+22,"text-anchor":"middle"},formatReadingDate(new Date(timestamp).toISOString().slice(0,10))));
    }
    dateChart.append(svgElement("text",{x:(datePlot.left+datePlot.right)/2,y:datePlot.bottom+49,"text-anchor":"middle"},"Assessment date"));
    languages.forEach(function(language){
      var points=datedAttempts.filter(function(attempt){return attempt.language===language})
        .sort(function(a,b){return a.timestamp-b.timestamp||a.attemptNo-b.attemptNo});
      points.forEach(function(point,index){
        if(index===0)return;
        var previous=points[index-1];
        dateChart.append(svgElement("line",{
          x1:xForDate(previous.timestamp),y1:yForLevel(previous.level),
          x2:xForDate(point.timestamp),y2:yForLevel(point.level),
          class:"parent-reading-date-trend-series",
          "data-language":language
        }));
      });
      points.forEach(function(point){
        var marker=svgElement("circle",{
          cx:xForDate(point.timestamp),cy:yForLevel(point.level),r:7,
          class:"parent-reading-date-trend-point",
          "data-language":language
        });
        marker.append(svgElement("title",{},language+" - "+point.period+" "+formatReadingAttempt(point.attemptNo)+": "+point.level+" on "+formatReadingDate(point.assessedDate)));
        dateChart.append(marker);
      });
    });
    dateChart.setAttribute("aria-label","Reading progress by assessment date. "+datedAttempts.map(function(attempt){
      return attempt.language+" "+attempt.period+" "+formatReadingAttempt(attempt.attemptNo)+": "+attempt.level+" on "+formatReadingDate(attempt.assessedDate);
    }).join("; "));
  }

  function parseReadingDate(value){
    if(typeof value!=="string"||! /^\d{4}-\d{2}-\d{2}$/.test(value))return null;
    var timestamp=Date.parse(value+"T00:00:00Z");
    return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===value?timestamp:null;
  }

  function formatReadingDate(value){
    var timestamp=parseReadingDate(value);
    return timestamp===null?"No date":new Date(timestamp).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"});
  }

  function formatReadingAttempt(attemptNo){
    var number=Number(attemptNo);
    var suffix=number%100>=11&&number%100<=13?"th"
      :number%10===1?"st":number%10===2?"nd":number%10===3?"rd":"th";
    return number+suffix;
  }

  function renderParentLearner(index){
    if(!parentPortalData)return;
    var learner=parentPortalData.learners[index];
    if(!learner)return;
    var profile=$("parentLearnerProfile");
    profile.replaceChildren();
    learner.profile.forEach(function(field){
      var item=document.createElement("div");
      item.className="detail-item";
      var label=document.createElement("dt");
      label.textContent=field.label;
      var value=document.createElement("dd");
      value.textContent=field.value||"—";
      item.append(label,value);
      profile.append(item);
    });

    renderParentReadingTrend(learner);
    var reading=$("parentReadingProgress");
    reading.replaceChildren();
    parentPortalData.readingPeriods.forEach(function(period){
      var card=document.createElement("article");
      card.className="parent-reading-period period-"+period.toLowerCase();
      var heading=document.createElement("h3");
      var periodNames={
        BOSY:"Beginning of School Year",
        MOSY:"Middle of School Year",
        EOSY:"End of School Year"
      };
      heading.textContent=period;
      var periodCaption=document.createElement("p");
      periodCaption.className="parent-reading-period-caption";
      periodCaption.textContent=periodNames[period]||"Assessment period";
      card.append(heading,periodCaption);
      parentPortalData.readingLanguages.forEach(function(language){
        var result=learner.reading[period][language];
        var entry=document.createElement("section");
        entry.className="parent-reading-language";
        var header=document.createElement("div");
        header.className="parent-reading-language-header";
        var label=document.createElement("span");
        label.textContent=language;
        var value=document.createElement("strong");
        value.textContent=result.level||"Not assessed";
        if(!result.level)value.classList.add("is-unassessed");
        var levelClasses={
          "Non-reader":"level-non-reader",
          "Frustration":"level-frustration",
          "Instructional":"level-instructional",
          "Independent":"level-independent"
        };
        var levelClass=levelClasses[result.level];
        if(levelClass)value.classList.add(levelClass);
        header.append(label,value);
        entry.append(header);
        if(result.level){
          var levels=["Non-reader","Frustration","Instructional","Independent"];
          var levelIndex=levels.indexOf(result.level);
          var steps=document.createElement("div");
          steps.className="parent-reading-steps";
          steps.setAttribute("role","img");
          steps.setAttribute("aria-label",language+" reading level: "+result.level);
          steps.style.setProperty("--reading-progress",Math.max(0,levelIndex)/(levels.length-1)*100+"%");
          levels.forEach(function(level,index){
            var step=document.createElement("div");
            step.className="parent-reading-step";
            if(index<=levelIndex)step.classList.add("is-complete");
            if(index===levelIndex){
              step.classList.add("is-current");
              if(levelClass)step.classList.add(levelClass);
            }
            var dot=document.createElement("span");
            dot.className="parent-reading-step-dot";
            var stepLabel=document.createElement("span");
            stepLabel.textContent=level;
            step.append(dot,stepLabel);
            steps.append(step);
          });
          entry.append(steps);
        }
        var assessedDate=document.createElement("p");
        assessedDate.className="parent-reading-date";
        assessedDate.textContent=result.assessedDate
          ?"Latest: "+formatReadingAttempt(result.attemptNo||1)+" · Assessed "+result.assessedDate
          :"";
        entry.append(assessedDate);
        if(result.attempts&&result.attempts.length){
          var history=document.createElement("div");
          history.className="parent-reading-attempt-history";
          var historyTitle=document.createElement("h4");
          historyTitle.textContent="Assessment history";
          var historyList=document.createElement("ol");
          result.attempts.slice().sort(function(left,right){return left.attemptNo-right.attemptNo})
            .forEach(function(attempt){
              var historyItem=document.createElement("li");
              historyItem.textContent=formatReadingAttempt(attempt.attemptNo)+": "+attempt.level
                +(attempt.assessedDate?" · "+attempt.assessedDate:"");
              historyList.append(historyItem);
            });
          history.append(historyTitle,historyList);
          entry.append(history);
        }
        card.append(entry);
      });
      reading.append(card);
    });

    var philIriResults=$("parentPhilIriProgress");
    philIriResults.replaceChildren();
    var philIriResultCount=0;
    parentPortalData.readingPeriods.forEach(function(period){
      ["Pretest","Posttest"].forEach(function(assessmentType){
        parentPortalData.readingLanguages.forEach(function(language){
          var result=learner.philIri&&learner.philIri[period]
            &&learner.philIri[period][assessmentType]
            &&learner.philIri[period][assessmentType][language];
          if(!result)return;
          philIriResultCount+=1;
          var card=document.createElement("article");
          card.className="parent-philiri-result";
          var heading=document.createElement("h4");
          heading.textContent=period+" "+assessmentType+" · "+language;
          var assessed=document.createElement("p");
          assessed.textContent=result.assessedDate?"Assessed "+formatReadingDate(result.assessedDate):"Assessment date not recorded";
          card.append(heading,assessed);
          var gst=result.gst;
          if(gst){
            var gstLine=document.createElement("p");
            gstLine.append("GST: ");
            var gstDescription=gst.score+"/"+gst.totalItems+" ("+gst.percentageScore+"%) · "
              +(gst.passed?"Passed":"Individualized assessment required");
            gstLine.append(document.createTextNode(gstDescription));
            card.append(gstLine);
          }
          var autoScore=result.autoScoring;
          if(autoScore){
            var autoScoreLine=document.createElement("p");
            autoScoreLine.textContent="Auto-Scoring Form: GST "
              +(autoScore.gstScore===null||autoScore.gstScore===undefined?"—":autoScore.gstScore+" ("+autoScore.gstStatus+")")
              +" · Oral "+(autoScore.oralReading===null||autoScore.oralReading===undefined?"—":(autoScore.oralReading*100).toFixed(1)+"%")
              +" · Comprehension "+(autoScore.comprehension===null||autoScore.comprehension===undefined?"—":(autoScore.comprehension*100).toFixed(1)+"%")
              +" · "+(autoScore.readingLevel||"Level pending");
            card.append(autoScoreLine);
          }
          ["Oral Reading","Silent Reading"].forEach(function(mode){
            var individual=result.individualized&&result.individualized[mode];
            if(!individual)return;
            var readingLine=document.createElement("p");
            readingLine.append(document.createElement("strong"));
            readingLine.lastChild.textContent=mode+": ";
            readingLine.append(document.createTextNode(
              individual.readingLevel+" · "+individual.wordsPerMinute+" WPM · "
                +individual.accuracyPercentage+"% accuracy · "+individual.comprehensionPercentage+"% comprehension"
            ));
            if(individual.passage){
              readingLine.append(document.createTextNode(" · Passage: "+individual.passage));
            }
            card.append(readingLine);
          });
          var intervention=result.intervention||{};
          var interventionParts=[];
          if(intervention.recommendedIntervention)interventionParts.push(intervention.recommendedIntervention);
          var interventionDates=[intervention.interventionStartDate,intervention.interventionEndDate].filter(Boolean);
          if(interventionDates.length)interventionParts.push("Dates: "+interventionDates.join(" to "));
          if(intervention.difficultyObserved)interventionParts.push("Difficulty: "+intervention.difficultyObserved);
          if(interventionParts.length){
            var interventionLine=document.createElement("p");
            interventionLine.textContent="Intervention: "+interventionParts.join(" · ");
            card.append(interventionLine);
          }
          if(intervention.progressNotes){
            var progressLine=document.createElement("p");
            progressLine.textContent="Progress: "+intervention.progressNotes;
            card.append(progressLine);
          }
          if(intervention.teacherRemarks){
            var remarksLine=document.createElement("p");
            remarksLine.textContent="Teacher remarks: "+intervention.teacherRemarks;
            card.append(remarksLine);
          }
          philIriResults.append(card);
        });
      });
    });
    $("parentPhilIriEmpty").hidden=philIriResultCount!==0;

    var attendanceBody=$("parentAttendanceRecords");
    attendanceBody.replaceChildren();
    $("parentAttendanceEmpty").hidden=learner.attendance.length!==0;
    learner.attendance.forEach(function(record){
      var row=document.createElement("tr");
      var date=document.createElement("td");
      date.textContent=record.date;
      var status=document.createElement("td");
      status.textContent=record.status;
      var reason=document.createElement("td");
      reason.textContent=record.reason||"";
      row.append(date,status,reason);
      attendanceBody.append(row);
    });

    var gradeRecords=$("parentGradeRecords");
    gradeRecords.replaceChildren();
    var table=document.createElement("table");
    table.className="parent-grade-table";
    var tableHead=document.createElement("thead");
    var headerRow=document.createElement("tr");
    var subjectHeader=document.createElement("th");
    subjectHeader.scope="col";
    subjectHeader.textContent="Subject";
    headerRow.append(subjectHeader);
    parentPortalData.gradeTerms.forEach(function(term){
      var termHeader=document.createElement("th");
      termHeader.scope="col";
      termHeader.textContent=term;
      headerRow.append(termHeader);
    });
    var generalHeader=document.createElement("th");
    generalHeader.scope="col";
    generalHeader.textContent="Average";
    headerRow.append(generalHeader);
    tableHead.append(headerRow);

    var body=document.createElement("tbody");
    parentPortalData.gradeSubjects.forEach(function(subject){
      var row=document.createElement("tr");
      var label=document.createElement("th");
      label.scope="row";
      label.textContent=subject.label;
      row.append(label);
      var termGrades=[];
      parentPortalData.gradeTerms.forEach(function(term){
        var grade=document.createElement("td");
        var value=learner.grades[term][subject.key];
        var hasGrade=typeof value==="number"&&Number.isFinite(value);
        grade.textContent=hasGrade?String(value):"—";
        row.append(grade);
        termGrades.push(hasGrade?value:null);
      });
      var generalGrade=document.createElement("td");
      generalGrade.className="parent-grade-general";
      generalGrade.textContent=termGrades.every(function(value){return value!==null})
        ?(termGrades.reduce(function(total,value){return total+value},0)/termGrades.length).toFixed(2)
        :"—";
      row.append(generalGrade);
      body.append(row);
    });

    var generalAverageRow=document.createElement("tr");
    var generalAverageLabel=document.createElement("th");
    generalAverageLabel.scope="row";
    generalAverageLabel.textContent="General Average";
    generalAverageRow.append(generalAverageLabel);
    var coreSubjects=parentPortalData.generalAverageSubjects;
    parentPortalData.gradeTerms.forEach(function(term){
      var averageCell=document.createElement("td");
      generalAverageRow.append(averageCell);
    });
    var allCoreGrades=[];
    parentPortalData.gradeTerms.forEach(function(term){
      coreSubjects.forEach(function(subject){
        allCoreGrades.push(learner.grades[term][subject]);
      });
    });
    var completeOverallAverage=allCoreGrades.length>0&&allCoreGrades.every(function(value){
      return typeof value==="number"&&Number.isFinite(value);
    });
    var overallAverageCell=document.createElement("td");
    overallAverageCell.className="parent-grade-overall";
    var overallAverage=completeOverallAverage
      ?Number((allCoreGrades.reduce(function(total,value){return total+value},0)/allCoreGrades.length).toFixed(2))
      :null;
    overallAverageCell.append(overallAverage===null?"—":overallAverage.toFixed(2));
    var overallInterpretation=overallAverage===null?null:getGradeInterpretation(overallAverage);
    if(overallInterpretation){
      var overallDescriptor=document.createElement("small");
      overallDescriptor.className="grade-descriptor";
      overallDescriptor.textContent=overallInterpretation.label+" ("+overallInterpretation.range+") — "+overallInterpretation.description;
      overallAverageCell.append(overallDescriptor);
    }
    generalAverageRow.append(overallAverageCell);
    var footer=document.createElement("tfoot");
    footer.append(generalAverageRow);
    table.append(tableHead,body,footer);
    var tableWrap=document.createElement("div");
    tableWrap.className="table-wrap";
    tableWrap.append(table);
    gradeRecords.append(tableWrap,createGradeInterpretationNote());
    parentSelectedLearnerIndex=index;
    $("parentLearnerRecords").hidden=false;
  }

  function setPortalPage(user){
    window.dispatchEvent(new Event("lessonPlanSourcesClear"));
    currentUser=user;
    rosterStudents=[];
    rosterParents=[];
    mpsLearners=[];
    mpsReportContext="";
    activeStudentSection="__all__";
    pendingStudentSection="__all__";
    studentSectionLocked=false;
    document.documentElement.dataset.role=user.role;
    document.body.classList.add("portal-active");
    $("authCard").hidden=true;
    $("portal").hidden=false;
    $("sideName").textContent=user.name;
    $("topName").textContent=user.name;
    $("topbarCalendar").hidden=user.role!=="teacher";
    if(user.role==="teacher"&&window.startTeacherCalendarDeadlineNotifications){
      window.startTeacherCalendarDeadlineNotifications();
    }else if(window.stopTeacherCalendarDeadlineNotifications){
      window.stopTeacherCalendarDeadlineNotifications();
    }
    $("sideBrandTitle").textContent=user.role==="parent"?"Parent's Portal":"GraceDesk";
    $("navSectionLabel").textContent=user.role==="parent"?"Learner information":"Classroom";
    $("topProfileInitials").textContent=user.name.trim().split(/\s+/).slice(0,2).map(function(part){return part.charAt(0).toUpperCase()}).join("")||"T";
    setTeacherProfilePhoto(false);
    $("topSettingsButton").hidden=user.role!=="teacher";
    if(window.refreshUpdateAlert)window.refreshUpdateAlert();
    $("sideRole").textContent=user.role==="parent"?"Parent":user.isAdmin?"Teacher · Admin":"Teacher";
    $("adminClassSwitcher").hidden=!user.isAdmin;
    $("menuToggle").hidden=false;
    $("teacherSidebarNav").hidden=user.role!=="teacher";
    $("parentSidebarNav").hidden=true;
    $("navStudents").hidden=false;
    $("navAttendance").hidden=false;
    $("navEClass").hidden=false;
    $("navTermGrades").hidden=false;
    $("navSf10").hidden=false;
    $("navSf10").setAttribute("aria-disabled","false");
    $("navSf10").title="Open SF 10";
    $("navGradeSummary").hidden=false;
    $("navPhilIri").hidden=false;
    $("navRma").hidden=false;
    $("navNutritionalStatus").hidden=false;
    $("navRma").disabled=false;
    $("navRma").removeAttribute("aria-disabled");
    $("navRma").title="Open RMA";
    $("navAssessmentItemAnalysis").hidden=!user.isAdmin;
    $("navAssessmentItemAnalysis").setAttribute("aria-disabled",String(!user.isAdmin));
    $("navAssessmentItemAnalysis").title=user.isAdmin?"Open Item Analysis":"Available to administrators only";
    $("navAssessmentDifficultyIndex").hidden=!user.isAdmin;
    $("navAssessmentDifficultyIndex").setAttribute("aria-disabled",String(!user.isAdmin));
    $("navAssessmentDifficultyIndex").title=user.isAdmin?"Open Difficulty Index":"Available to administrators only";
    $("navAssessmentLeastMastered").hidden=!user.isAdmin;
    $("navAssessmentLeastMastered").setAttribute("aria-disabled",String(!user.isAdmin));
    $("navAssessmentLeastMastered").title=user.isAdmin?"Open Least Mastered Competencies":"Available to administrators only";
    $("navTeacherProfile").hidden=false;
    $("navSettings").hidden=false;
    $("studentsPage").hidden=user.role!=="teacher";
    $("attendancePage").hidden=true;
    $("eClassPage").hidden=true;
    $("termGradesPage").hidden=true;
    $("sf10Page").hidden=true;
    $("gradeSummaryPage").hidden=true;
    $("philIriPage").hidden=true;
    $("readingProgressPage").hidden=true;
    $("rmaPage").hidden=true;
    $("nutritionalStatusPage").hidden=true;
    $("teacherProfilePage").hidden=true;
    $("settingsPage").hidden=true;
    $("toolsPage").hidden=true;
    $("parentPage").hidden=user.role==="teacher";
    if(user.role==="teacher"){
      $("classSummary").textContent="Manage the student records for your class.";
      if(!user.mustChangePassword)loadStudents();
    }else{
      $("parentWelcomeMessage").textContent="Welcome, "+user.name+". Your class and linked learner information is here.";
      $("parentPortalNotice").textContent="";
      $("parentClassroom").textContent="Loading class...";
      $("parentTeacher").textContent="Loading teacher...";
      $("parentChildrenCount").textContent="Loading learners...";
      $("parentLearnerPickerWrap").hidden=true;
      $("parentChildrenEmpty").hidden=true;
      $("parentLearnerRecords").hidden=true;
      parentPortalData=null;
      parentSelectedLearnerIndex=0;
      showParentSection("parentStudentInfo");
    }
  }

  async function enter(user){
    var session=await api("/api/auth/session");
    var sessionUser=session.user;
    var wrongPortal=(entryType==="parents"&&sessionUser.role!=="parent")
      ||(entryType==="main"&&sessionUser.role!=="teacher");
    if(wrongPortal){
      await api("/api/auth/logout",{method:"POST"});
      if(window.gradePortal&&typeof window.gradePortal.clearPortalAuthCookies==="function"){
        await window.gradePortal.clearPortalAuthCookies();
      }
      throw new Error(entryType==="parents"
        ?"This account is not a parent account. Sign in through the Parents Portal."
        :"Only teacher accounts can use the Teacher Portal. Sign in through the Parents Portal instead.");
    }
    user.id=session.user.userId;
    user.role=sessionUser.role;
    user.isAdmin=sessionUser.isAdmin;
    user.mustChangePassword=sessionUser.mustChangePassword;
    if(session.user.classCode)user.classCode=session.user.classCode;
    user.activeClassId=session.user.activeClassId;
    if(user.mustChangePassword){
      setPortalPage(user);
      $("forcedPasswordError").textContent="";
      if(!$("forcedPasswordDialog").open)$("forcedPasswordDialog").showModal();
      return;
    }
    var aboutTermsAccepted=false;
    try{
      aboutTermsAccepted=window.localStorage.getItem("gradePortalAboutAccepted:"+user.id)==="yes";
    }catch(error){
      throw new Error("This browser cannot save the app notice. Enable browser storage, then sign in again.");
    }
    setPortalPage(user);
    if($("forcedPasswordDialog").open)$("forcedPasswordDialog").close();
    $("aboutTermsError").textContent="";
    if(!aboutTermsAccepted&&!$("aboutTermsDialog").open)$("aboutTermsDialog").showModal();
    if(user.role==="teacher"){
      try{
        $("classSummary").textContent="Manage the student records for your class.";
        var profile=await api("/api/teacher/profile");
        $("teacherProfileSchoolYear").value=profile.schoolYear||"";
        $("teacherProfileFirstDayOfSchool").value=profile.firstDayOfSchool||"";
        $("teacherProfileEndOfSchoolYear").value=profile.endOfSchoolYear||"";
        refreshAttendanceYears();
        availableSubjects=profile.availableSubjects||[];
        configureGradeSubjects(profile.gradeSubjects);
        configureEClassSubjects(profile.eClassSubjects,profile.gradeSubjects);
        setTeacherProfilePhoto(profile.hasPhoto);
        if(user.isAdmin){
          var adminResult=await api("/api/admin/classes");
          adminClasses=adminResult.classes;
          var activeClassSelect=$("adminActiveClass");
          activeClassSelect.replaceChildren();
          adminClasses.forEach(function(classroom){
            var details=[classroom.teacherName,"Classroom "+classroom.classroom,classroom.grade,classroom.section,classroom.schoolName]
              .filter(Boolean).join(" · ");
            activeClassSelect.add(new Option(details,classroom.id));
          });
          if(!adminClasses.some(function(classroom){return classroom.id===user.activeClassId})){
            throw new Error("The administrator's assigned class is not available for class access.");
          }
          activeClassSelect.value=user.activeClassId;
        }
      }catch(error){
        $("studentNotice").textContent=error.message;
      }
      showDashboardPage("dashboard");
    }else{
      try{
        var parentPortal=await api("/api/parent/portal");
        if(parentPortal.learners.some(function(learner){return !Array.isArray(learner.attendance)})){
          throw new Error("Restart the portal server to load attendance records.");
        }
        $("parentWelcomeMessage").textContent="Welcome, "+parentPortal.parentName+". Your class and linked learner information is here.";
        $("parentClassroom").textContent=parentPortal.classroomNumber||"Not available";
        $("parentTeacher").textContent=parentPortal.teacherName||"Not available";
        parentPortalData=parentPortal;
        $("parentPortalSyncStatus").textContent="Connected. Teacher updates sync automatically while this portal is open.";
        $("parentSidebarNav").hidden=parentPortal.learners.length===0;
        $("parentChildrenCount").textContent=parentPortal.learners.length+" linked "+(parentPortal.learners.length===1?"learner":"learners");
        $("parentLearnerPicker").replaceChildren();
        parentPortal.learners.forEach(function(learner,index){
          $("parentLearnerPicker").add(new Option(learner.name,String(index)));
        });
        $("parentLearnerPickerWrap").hidden=parentPortal.learners.length===0;
        $("parentChildrenEmpty").hidden=parentPortal.learners.length!==0;
        $("parentLearnerRecords").hidden=parentPortal.learners.length===0;
        if(parentPortal.learners.length){
          renderParentLearner(0);
          $("parentLearnerPicker").onchange=function(){
            renderParentLearner(Number(this.value));
          };
        }
      }catch(error){
        $("parentSidebarNav").hidden=true;
        $("parentClassroom").textContent="Unavailable";
        $("parentTeacher").textContent="Unavailable";
        $("parentChildrenCount").textContent="Unable to load";
        $("parentPortalNotice").textContent=error.message;
        $("parentPortalNotice").classList.add("error");
      }
    }
  }

  function showParentSection(targetId){
    document.querySelectorAll("[data-parent-target]").forEach(function(button){
      var selected=button.dataset.parentTarget===targetId;
      var section=$(button.dataset.parentTarget);
      if(section)section.hidden=!selected;
      if(selected)button.setAttribute("aria-current","page");
      else button.removeAttribute("aria-current");
    });
  }

  async function refreshParentPortalData(button,successMessage){
    if(!currentUser||currentUser.role!=="parent"||!parentPortalData||parentPortalRefreshInProgress)return;
    if(button&&button.disabled)return;
    parentPortalRefreshInProgress=true;
    var selectedLearner=parentPortalData&&parentPortalData.learners[parentSelectedLearnerIndex];
    var originalText=button?button.textContent:"";
    if(button){
      button.disabled=true;
      button.textContent="Refreshing...";
    }
    $("parentPortalNotice").textContent="";
    $("parentPortalNotice").classList.remove("error");
    try{
      var updatedPortal=await api("/api/parent/portal");
      if(!updatedPortal||!Array.isArray(updatedPortal.learners)){
        throw new Error("Parent portal data could not be refreshed. Restart the portal server and try again.");
      }
      if(updatedPortal.learners.some(function(learner){return !Array.isArray(learner.attendance)})){
        throw new Error("Restart the portal server to load attendance records.");
      }
      parentPortalData=updatedPortal;
      $("parentSidebarNav").hidden=parentPortalData.learners.length===0;
      $("parentWelcomeMessage").textContent="Welcome, "+parentPortalData.parentName+". Your class and linked learner information is here.";
      $("parentClassroom").textContent=parentPortalData.classroomNumber||"Not available";
      $("parentTeacher").textContent=parentPortalData.teacherName||"Not available";
      $("parentChildrenCount").textContent=parentPortalData.learners.length+" linked "+(parentPortalData.learners.length===1?"learner":"learners");
      $("parentLearnerPicker").replaceChildren();
      parentPortalData.learners.forEach(function(learner,index){
        $("parentLearnerPicker").add(new Option(learner.name,String(index)));
      });
      $("parentLearnerPickerWrap").hidden=parentPortalData.learners.length===0;
      $("parentChildrenEmpty").hidden=parentPortalData.learners.length!==0;
      $("parentLearnerRecords").hidden=parentPortalData.learners.length===0;
      if(parentPortalData.learners.length){
        var nextIndex=selectedLearner
          ?parentPortalData.learners.findIndex(function(learner){return learner.id===selectedLearner.id})
          :-1;
        renderParentLearner(nextIndex<0?0:nextIndex);
        $("parentLearnerPicker").value=String(parentSelectedLearnerIndex);
        $("parentLearnerPicker").onchange=function(){
          renderParentLearner(Number(this.value));
        };
      }
      $("parentPortalSyncStatus").textContent="Last synced "+new Date().toLocaleTimeString([],{
        hour:"numeric",minute:"2-digit"
      })+". Teacher updates sync automatically while this portal is open.";
      if(successMessage)$("parentPortalNotice").textContent=successMessage;
    }catch(error){
      $("parentPortalNotice").textContent=error.message;
      $("parentPortalNotice").classList.add("error");
      $("parentPortalSyncStatus").textContent="Could not sync the latest teacher updates. Try Refresh data.";
    }finally{
      parentPortalRefreshInProgress=false;
      if(button){
        button.disabled=false;
        button.textContent=originalText;
      }
    }
  }

  document.querySelectorAll("[data-parent-target]").forEach(function(button){
    button.onclick=function(){
      showParentSection(button.dataset.parentTarget);
      if(button.dataset.parentTarget==="parentReadingSection"){
        refreshParentPortalData($("refreshParentReading"),"Reading progress refreshed.");
      }
      closeSidebar();
    };
  });
  $("refreshParentAttendance").onclick=function(){
    refreshParentPortalData(this,"Attendance refreshed.");
  };
  $("refreshParentReading").onclick=function(){
    refreshParentPortalData(this,"Reading progress refreshed.");
  };
  $("refreshParentPortal").onclick=function(){
    refreshParentPortalData(this,"Parent portal data refreshed.");
  };
  window.setInterval(function(){
    if(currentUser&&currentUser.role==="parent"&&document.visibilityState==="visible"){
      refreshParentPortalData(null);
    }
  },30000);
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible"&&currentUser&&currentUser.role==="parent"){
      refreshParentPortalData(null);
    }
  });
  window.addEventListener("focus",function(){
    if(currentUser&&currentUser.role==="parent")refreshParentPortalData(null);
  });

  function closeSidebar(){
    $("portal").classList.remove("sidebar-open");
    $("portal").classList.remove("sidebar-collapsed");
    $("menuToggle").setAttribute("aria-expanded","false");
    $("menuToggle").setAttribute("aria-label","Open navigation menu");
  }

  function openStudentDialog(){
    $("studentFormError").textContent="";
    $("studentForm").reset();
    populateSectionControls(activeStudentSection);
    $("studentSection").value=activeStudentSection==="__all__"||activeStudentSection==="__unassigned__"
      ?defaultStudentSection||handledSections[0]||""
      :activeStudentSection;
    $("studentDialog").showModal();
  }

  $("menuToggle").onclick=function(){
    var isMobile=window.matchMedia("(max-width: 760px)").matches;
    var isOpen;
    var isExpanded;
    if(isMobile){
      $("portal").classList.remove("sidebar-collapsed");
      isOpen=$("portal").classList.toggle("sidebar-open");
      isExpanded=isOpen;
    }else{
      $("portal").classList.remove("sidebar-open");
      isOpen=$("portal").classList.toggle("sidebar-collapsed");
      isExpanded=!isOpen;
    }
    $("menuToggle").setAttribute("aria-expanded",String(isExpanded));
    $("menuToggle").setAttribute("aria-label",isOpen
      ?(isMobile?"Close navigation menu":"Show navigation menu")
      :"Open navigation menu");
  };
  $("sidebarScrim").onclick=closeSidebar;
  $("adminActiveClass").onchange=async function(){
    if(!currentUser||!currentUser.isAdmin)return;
    var classId=this.value;
    var previousClassId=currentUser.activeClassId;
    this.disabled=true;
    try{
      var activeClass=await api("/api/admin/active-class",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({classId:classId})
      });
      var session=await api("/api/auth/session");
      currentUser.activeClassId=activeClass.classId;
      currentUser.classCode=session.user.classCode;
      $("classSummary").textContent=currentUser.classCode
        ?"Class code for parents: "+currentUser.classCode
        :"Manage the student records for this class.";
      $("studentNotice").textContent="Managing "+activeClass.teacherName+"'s class.";
      $("studentNotice").classList.remove("error");
      showDashboardPage("students");
      await loadStudents();
    }catch(error){
      this.value=previousClassId;
      $("studentNotice").textContent=error.message;
      $("studentNotice").classList.add("error");
    }finally{
      this.disabled=false;
    }
  };
  $("navDashboard").onclick=function(){showDashboardPage("dashboard")};
  $("navStudents").onclick=function(){showDashboardPage("students")};
  $("navAttendance").onclick=function(){showDashboardPage("attendance")};
  $("navEClass").onclick=function(){showDashboardPage("eClass")};
  $("navTermGrades").onclick=function(){showDashboardPage("grades")};
  $("navSf10").onclick=function(){showDashboardPage("sf10")};
  $("navGradeSummary").onclick=function(){showDashboardPage("summary")};
  $("termGradeToggle").onclick=function(){
    var expanded=this.getAttribute("aria-expanded")==="true";
    this.setAttribute("aria-expanded",String(!expanded));
    $("termGradeSubnav").hidden=expanded;
  };
  $("assessmentDashboardToggle").onclick=function(){
    var expanded=this.getAttribute("aria-expanded")==="true";
    this.setAttribute("aria-expanded",String(!expanded));
    $("assessmentDashboardSubnav").hidden=expanded;
  };
  $("navAssessmentMps").onclick=function(){showDashboardPage("assessmentMps")};
  $("navAssessmentMpsSummary").onclick=function(){showDashboardPage("assessmentMpsSummary")};
  $("mpsSummaryTerm").addEventListener("change",function(){loadStudents().then(loadMpsSummaryFromEClass)});
  $("mpsSummaryTestType").addEventListener("change",function(){loadStudents().then(loadMpsSummaryFromEClass)});
  $("refreshMpsSummary").onclick=function(){
    updateMpsSummaryMetadata();
    loadStudents().then(loadMpsSummaryFromEClass);
  };
  $("printMpsSummary").onclick=function(){
    document.body.classList.add("mps-summary-printing");
    window.print();
  };
  $("navAssessmentDifficultyIndex").onclick=function(){
    renderDifficultyIndexReport();
    showDashboardPage("assessmentDifficultyIndex");
  };
  $("difficultyIndexLearners").addEventListener("input",updateDifficultyIndexRows);
  $("difficultyIndexTotalItems").addEventListener("change",renderDifficultyIndexRows);
  $("difficultyIndexRows").addEventListener("input",updateDifficultyIndexRows);
  $("difficultyIndexSubject").addEventListener("change",function(){
    $("mpsSubject").value=this.value;
  });
  $("difficultyIndexPrintReport").onclick=function(){
    document.body.classList.add("difficulty-index-printing");
    window.print();
  };
  $("assessmentMpsPage").addEventListener("input",function(event){
    var target=event.target;
    if(target.dataset.mpsScore!==undefined){
      var scoreLearner=mpsLearners[Number(target.dataset.mpsScore)];
      if(scoreLearner)scoreLearner.score=target.value;
      updateMpsReport();
    }else if(target.id==="mpsTotalItems"){
      updateMpsReport();
    }
  });
  $("mpsSubject").addEventListener("change",function(){
    populateMpsSubjectOptions($("mpsSection").value||activeStudentSection,this.value);
    loadMpsEclassScores(true);
  });
  $("mpsTestType").addEventListener("change",function(){
    loadMpsEclassScores(true);
  });
  $("mpsTerm").addEventListener("change",function(){
    loadMpsEclassScores(true);
  });
  $("mpsPrintReport").onclick=function(){
    document.body.classList.add("mps-printing");
    window.print();
  };
  $("mpsDownloadReport").onclick=async function(){
    var button=this;
    var notice=$("mpsNotice");
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    try{
      var learnerRows=Array.from($("mpsLearnerRows").querySelectorAll("tr"));
      var rows=mpsLearners.map(function(learner,index){
        var row=learnerRows[index];
        return {
          number:index+1,
          name:learner.name.trim(),
          rawScore:String(learner.score||"").trim(),
          totalItems:$("mpsTotalItems").value.trim(),
          percentage:row&&row.cells[4]?row.cells[4].textContent.trim():"",
          remark:row&&row.cells[5]?row.cells[5].textContent.trim():"",
        };
      }).filter(function(row){return row.name!==""});
      rows=rows.map(function(row,index){
        var domRow=learnerRows.find(function(candidate){
          return candidate.cells[1]&&candidate.cells[1].textContent.trim()===row.name;
        });
        return {
          number:index+1,
          name:row.name,
          rawScore:row.rawScore,
          totalItems:row.totalItems,
          percentage:domRow&&domRow.cells[4]?domRow.cells[4].textContent.trim():row.percentage,
          remark:domRow&&domRow.cells[5]?domRow.cells[5].textContent.trim():row.remark,
        };
      });
      if(!rows.length)throw new Error("There are no learner records to include in the MPS document.");
      var response=await fetch("/api/assessment/mps/export",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          title:$("assessmentMpsTitle").textContent.trim(),
          subject:$("mpsSubject").selectedOptions[0]
            ?$("mpsSubject").selectedOptions[0].textContent.trim():"",
          gradeLevel:$("mpsGradeLevel").value.trim(),
          section:$("mpsSection").value.trim(),
          schoolYear:$("mpsSchoolYear").value.trim(),
          term:$("mpsTerm").value,
          testType:$("mpsTestType").selectedOptions[0]
            ?$("mpsTestType").selectedOptions[0].textContent.trim():"",
          totalItems:$("mpsTotalItems").value.trim(),
          examinationDate:$("mpsExaminationDate").value.trim(),
          learners:rows,
          learnerCount:$("mpsLearnerCount").textContent.trim(),
          average:$("mpsAverage").textContent.trim(),
          averageDescriptor:$("mpsAverageDescriptor").textContent.trim(),
        })
      });
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to download the MPS Word document.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var filenameMatch=disposition.match(/filename="([^"]+)"/i);
      if(!filenameMatch||!/\.docx$/i.test(filenameMatch[1])){
        throw new Error("The server did not provide a Word document filename.");
      }
      var contentType=response.headers.get("content-type")||"";
      if(!/^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document(?:;|$)/i.test(contentType)){
        throw new Error("The server response is not a Word document.");
      }
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=filenameMatch[1];
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      notice.hidden=false;
      notice.classList.remove("error");
      notice.textContent="MPS Word document downloaded.";
    }catch(error){
      notice.hidden=false;
      notice.classList.add("error");
      notice.textContent="Could not download the MPS Word document: "+error.message;
    }finally{
      button.disabled=false;
      button.removeAttribute("aria-busy");
    }
  };
  window.addEventListener("afterprint",function(){document.body.classList.remove("mps-summary-printing","mps-printing","difficulty-index-printing","item-analysis-printing","rma-printing","philiri-printing")});
  $("navAssessmentItemAnalysis").onclick=function(){
    renderItemAnalysisReport();
    showDashboardPage("assessmentItemAnalysis");
  };
  $("itemAnalysisSubject").addEventListener("change",function(){
    $("mpsSubject").value=this.value;
    loadMpsEclassScores(true);
    renderItemAnalysisReport();
  });
  $("itemAnalysisTerm").addEventListener("change",function(){
    $("mpsTerm").value=this.value;
    loadMpsEclassScores(true);
    renderItemAnalysisReport();
  });
  $("itemAnalysisTestType").addEventListener("change",function(){
    $("mpsTestType").value=this.value;
    loadMpsEclassScores(true);
    renderItemAnalysisReport();
  });
  $("itemAnalysisPrintReport").onclick=function(){
    document.body.classList.add("item-analysis-printing");
    window.print();
  };
  $("itemAnalysisImportTos").onclick=function(){
    $("itemAnalysisTosFile").click();
  };
  $("itemAnalysisTosFile").addEventListener("change",async function(){
    var file=this.files&&this.files[0];
    if(!file)return;
    var button=$("itemAnalysisImportTos");
    button.disabled=true;
    button.textContent="Analyzing TOS...";
    $("itemAnalysisNotice").hidden=false;
    $("itemAnalysisNotice").classList.remove("error");
    $("itemAnalysisNotice").textContent="Reading learning competencies from "+file.name+"...";
    try{
      var bytes=new Uint8Array(await file.arrayBuffer());
      var binary="";
      for(var offset=0;offset<bytes.length;offset+=8192){
        binary+=String.fromCharCode.apply(null,bytes.subarray(offset,Math.min(offset+8192,bytes.length)));
      }
      var result=await api("/api/assessment/tos/import",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({fileName:file.name,contentBase64:btoa(binary)})
      });
      var competencyInputs=Array.from($("itemAnalysisRows").querySelectorAll("td:nth-child(2) input"));
      result.competencies.forEach(function(competency,index){
        if(competencyInputs[index])competencyInputs[index].value=competency;
      });
      $("itemAnalysisNotice").textContent=result.competencies.length
        ?"Imported "+result.competencies.length+" learning competenc"+(result.competencies.length===1?"y":"ies")+" from "+result.fileName+"."
        :"No learning competencies were found. Ensure the TOS has a column or heading labeled Learning Competency.";
    }catch(error){
      $("itemAnalysisNotice").classList.add("error");
      $("itemAnalysisNotice").textContent=error.message;
    }finally{
      button.disabled=false;
      button.textContent="Import TOS";
      this.value="";
    }
  });
  $("navAssessmentLeastMastered").onclick=function(){showDashboardPage("assessmentLeastMastered")};
  $("navPhilIri").onclick=function(){showDashboardPage("philIri")};
  $("philIriResultsTab").onclick=function(){showPhilIriTab("results")};
  $("philIriAutoScoringTab").onclick=function(){showPhilIriTab("scoring")};
  $("philIriReadingSummaryTab").onclick=function(){showPhilIriTab("reading-summary")};
  $("philIriAralProgramTab").onclick=function(){showPhilIriTab("aral-program")};
  $("refreshPhilIriResults").onclick=loadPhilIriAutoScoringResults;
  $("refreshPhilIriReadingSummary").onclick=loadPhilIriReadingSummary;
  $("philIriResultsCycle").onchange=loadPhilIriAutoScoringResults;
  $("savePhilIriAutoScore").onclick=persistSelectedPhilIriScores;
  $("navRma").onclick=function(){showDashboardPage("rma")};
  $("navNutritionalStatus").onclick=function(){showDashboardPage("nutritionalStatus")};
  $("nutritionalBosyTab").onclick=function(){selectNutritionalCycle("BOSY",false)};
  $("nutritionalEosyTab").onclick=function(){selectNutritionalCycle("EOSY",false)};
  $("nutritionalBosyTab").addEventListener("keydown",function(event){
    if(event.key==="ArrowRight"){event.preventDefault();selectNutritionalCycle("EOSY",true)}
  });
  $("nutritionalEosyTab").addEventListener("keydown",function(event){
    if(event.key==="ArrowLeft"){event.preventDefault();selectNutritionalCycle("BOSY",true)}
  });
  $("refreshNutritionalRoster").onclick=loadNutritionalStatusRoster;
  $("editNutritionalMeasurements").onclick=toggleNutritionalMeasurementsEditing;
  $("saveNutritionalMeasurements").onclick=saveAllNutritionalMeasurements;
  $("exportSF8").onclick=exportNutritionalStatusSF8;
  $("navTeacherProfile").onclick=function(){showDashboardPage("profile")};
  $("navSettings").onclick=function(){showDashboardPage("settings")};
  $("navTools").onclick=function(){showDashboardPage("tools")};
  $("dashboardOpenCalendar").onclick=function(){
    showDashboardPage("tools");
    if(!$("toolsPage").hidden)setActiveToolPanel("calendarPanel");
  };
  (function(){
    var panelIds=["tarpaulinPanel","lessonPlanPanel","calendarPanel","moreToolsPanel"];
    var lessonPlanInitialized=false;
    var lessonPlanMode="lesson-plan";
    var lessonPlanSourceFiles=[];
    var lessonPlanSourcesGenerating=false;
    var lessonPlanSourceGenerationController=null;
    var dailyLessonLogTopicChoices=[];
    var dailyLessonLogLearningAreaChoices=[];
    var dailyLessonLogParsedSources=null;
    var dailyLessonLogLanguage="filipino";
    var dailyLessonLogLoadedLanguage=null;
    var dailyLessonLogLoadingByLanguage={};
    var dailyLessonLogTemplateHtml={};
    var dailyLessonLogSaveTimer=null;
    function lessonPlanStorageKey(language,mode){
      var userKey=currentUser&&(currentUser.id||currentUser.username||currentUser.email);
      if(!userKey)throw new Error("Sign in to save a lesson plan draft.");
      var classKey=currentUser.activeClassId||currentUser.classId||currentUser.classCode||userKey;
      var modeKey=mode==="daily-lesson-log"?":daily-lesson-log":"";
      return "gracedesk-ilaw-v1:"+encodeURIComponent(String(userKey))+":"+encodeURIComponent(String(classKey))+modeKey+":"+language;
    }
    function lessonPlanModeStorageKey(){
      return lessonPlanStorageKey("selected-mode");
    }
    function setLessonPlanSourcesStatus(message,isError){
      var status=$("lessonPlanSourcesStatus");
      status.textContent=message;
      status.classList.toggle("error",Boolean(isError));
    }
    function formatLessonPlanSourceSize(size){
      if(size<1024)return size+" B";
      if(size<1024*1024)return (size/1024).toFixed(1)+" KB";
      return (size/(1024*1024)).toFixed(1)+" MB";
    }
    function clearLessonPlanSourcePreview(){
      $("lessonPlanSourcePreview").value="";
      $("lessonPlanSourcePreviewPanel").hidden=true;
      dailyLessonLogParsedSources=null;
      updateDailyLessonLogSourceDropdowns("");
      renderDailyLessonLogSessionOptions(null);
    }
    function renderDailyLessonLogSessionOptions(lessonPlan,content){
      content=content||$("dailyLessonLogDocument");
      var sessions=lessonPlan&&lessonPlan.sessions&&typeof lessonPlan.sessions==="object"
        ?lessonPlan.sessions:{};
      var keys=Object.keys(sessions).filter(function(key){return /^session_[1-5]$/.test(key)})
        .sort(function(left,right){return Number(left.slice(8))-Number(right.slice(8))});
      var headerRow=content.querySelector("tr.daily-lesson-log-session-row")
        ||Array.from(content.querySelectorAll("table tr")).find(function(row){
          return row.cells.length===6&&/\b(?:SESSION|SESYON)\s*1\b/i.test(row.cells[1].textContent);
        });
      if(!headerRow)return;
      for(var targetSession=1;targetSession<=5;targetSession++){
        var cell=headerRow.cells[targetSession];
        if(!cell)continue;
        var select=cell.querySelector("select.daily-lesson-log-session-source-select");
        if(!select){
          select=document.createElement("select");
          select.className="daily-lesson-log-session-source-select";
          select.contentEditable="false";
          select.setAttribute(
            "aria-label",
            "Choose a source session for DLL "+(dailyLessonLogLanguage==="filipino"?"SESYON ":"SESSION ")+targetSession,
          );
          cell.appendChild(select);
        }
        var selected=select.value;
        select.replaceChildren();
        var placeholder=document.createElement("option");
        placeholder.value="";
        placeholder.textContent=keys.length?"Choose source session":"No source sessions detected";
        select.appendChild(placeholder);
        keys.forEach(function(key){
          var number=Number(key.slice(8));
          var option=document.createElement("option");
          option.value=key;
          option.textContent="Source "+(dailyLessonLogLanguage==="filipino"?"SESYON ":"SESSION ")+number;
          select.appendChild(option);
        });
        select.disabled=!keys.length;
        if(keys.some(function(key){return key===selected}))select.value=selected;
      }
    }
    function extractDailyLessonLogSourceValues(preview,fieldLabels){
      var candidates=[];
      var seen=new Set();
      function addCandidate(value){
        var candidate=String(value||"").replace(/\s+/g," ").trim().replace(/^[\s"'`]+|[\s"'`]+$/g,"");
        if(!candidate||candidate.length>180||candidate.split(/\s+/).length>20)return;
        if(!/[A-Za-z\u00c0-\u024f]/.test(candidate))return;
        var key=candidate.toLocaleLowerCase();
        if(seen.has(key))return;
        seen.add(key);
        candidates.push(candidate);
      }
      var sourceSections=String(preview||"").replace(/\r/g,"").split(/(?=^Source:\s*)/im);
      var otherFieldLabels="Lesson\\s+Title|Learning\\s+Area|Subject|Teacher(?:'s)?\\s+Name|Grade(?:\\s+Level)?|Section|Number\\s+of\\s+Sessions|Sessions?|References?|AI\\s+Use(?:\\s+Declaration)?|Learning\\s+Objectives?|Learning\\s+Competencies?|Topic|Theme|Paksa|Pamagat\\s+ng\\s+Aralin|Mga\\s+Sanggunian|Pangalan\\s+ng\\s+Guro|Baitang|Bilang\\s+ng\\s+Sesyon|Larangan\\s+ng\\s+Pagkatuto|Asignatura";
      var valuePattern=new RegExp("\\b(?:"+fieldLabels+")\\b[ \\t]*(?::|[-–—])?[ \\t]*([\\s\\S]*?)(?=\\s+(?:"+otherFieldLabels+")\\b|\\t|\\n|$)","gi");
      sourceSections.forEach(function(section){
        var match;
        while((match=valuePattern.exec(section)))addCandidate(match[1]);
      });
      return candidates;
    }
    function extractDailyLessonLogTopicCandidates(preview){
      return extractDailyLessonLogSourceValues(preview,"Lesson\\s+Title");
    }
    function extractDailyLessonLogLearningAreaCandidates(preview){
      return extractDailyLessonLogSourceValues(preview,"Learning\\s+Area|Subject|Larangan\\s+ng\\s+Pagkatuto|Asignatura");
    }
    function renderDailyLessonLogSourceDropdown(sourceSelect,selected,choices,label){
      var placeholder=document.createElement("option");
      placeholder.value="";
      placeholder.textContent=choices.length
        ?"Select a "+label:"Generate a source preview to load "+label+" choices";
      sourceSelect.replaceChildren(placeholder);
      choices.forEach(function(value){
        var option=document.createElement("option");
        option.value=value;
        option.textContent=value;
        sourceSelect.appendChild(option);
      });
      if(selected&&!choices.some(function(value){return value===selected})){
        var savedOption=document.createElement("option");
        savedOption.value=selected;
        savedOption.textContent=selected;
        sourceSelect.appendChild(savedOption);
      }
      sourceSelect.value=selected;
    }
    function updateDailyLessonLogSourceDropdowns(preview,lessonPlan){
      var documentPanel=$("dailyLessonLogDocument");
      var topicSelect=documentPanel.querySelector("select.daily-lesson-log-topic-select");
      var learningAreaSelect=documentPanel.querySelector("select.daily-lesson-log-learning-area-select");
      if(preview!==undefined){
        dailyLessonLogTopicChoices=extractDailyLessonLogTopicCandidates(preview);
        dailyLessonLogLearningAreaChoices=extractDailyLessonLogLearningAreaCandidates(preview);
      }
      var globalInfo=lessonPlan&&lessonPlan.global_info;
      if(globalInfo){
        [[dailyLessonLogTopicChoices,globalInfo.pamagat],[dailyLessonLogLearningAreaChoices,globalInfo.larangan]]
          .forEach(function(entry){
            var value=String(entry[1]||"").trim();
            if(value&&!entry[0].some(function(candidate){return candidate.toLocaleLowerCase()===value.toLocaleLowerCase()})){
              entry[0].unshift(value);
            }
          });
      }
      if(topicSelect)renderDailyLessonLogSourceDropdown(
        topicSelect,topicSelect.value,dailyLessonLogTopicChoices,"lesson title",
      );
      if(learningAreaSelect)renderDailyLessonLogSourceDropdown(
        learningAreaSelect,learningAreaSelect.value,dailyLessonLogLearningAreaChoices,"learning area",
      );
      return {
        lessonTitles:dailyLessonLogTopicChoices.length,
        learningAreas:dailyLessonLogLearningAreaChoices.length,
      };
    }
    function findDailyLessonLogRow(content,labelPattern){
      return Array.from(content.querySelectorAll("table tr")).find(function(row){
        return row.cells[0]&&labelPattern.test(row.cells[0].textContent.replace(/\s+/g," ").trim());
      })||null;
    }
    function fillDailyLessonLogCell(cell,value){
      var text=String(value||"").trim();
      if(!cell||!text)return {changed:false,skipped:false};
      var existing=cell.textContent.replace(/\s+/g," ").trim();
      var placeholder=/^\(?\s*(?:REFERENCE|TOPIC|SUBJECT|LEARNING AREA|GRADE AND SECTION|NUMBER OF SESSIONS)\s*\)?$/i;
      if(existing&&!placeholder.test(existing))return {changed:false,skipped:true};
      var paragraph=document.createElement("p");
      paragraph.textContent=text;
      cell.replaceChildren(paragraph);
      return {changed:true,skipped:false};
    }
    function setDailyLessonLogSourceSelect(select,value){
      var text=String(value||"").trim();
      if(!select||!text||select.value)return false;
      var option=Array.from(select.options).find(function(candidate){
        return candidate.value.toLocaleLowerCase()===text.toLocaleLowerCase();
      });
      if(!option){
        option=document.createElement("option");
        option.value=text;
        option.textContent=text;
        select.appendChild(option);
      }
      select.value=option.value;
      return true;
    }
    function syncDailyLessonLogIntentions(content){
      content=content||$("dailyLessonLogDocument");
      var row=findDailyLessonLogRow(content,/^(?:intensyon|intentions?)\b/i);
      var intentionsCell=row&&row.cells[1];
      if(!intentionsCell)return false;
      var context=intentionsCell.querySelector("p.daily-lesson-log-intentions-context");
      var titleSelect=content.querySelector("select.daily-lesson-log-topic-select");
      var subjectSelect=content.querySelector("select.daily-lesson-log-learning-area-select");
      var title=String(titleSelect&&titleSelect.value||"").trim();
      var subject=String(subjectSelect&&subjectSelect.value||"").trim();
      var values=[];
      if(title)values.push((dailyLessonLogLanguage==="filipino"?"Napiling aralin: ":"Selected lesson: ")+title);
      if(subject)values.push((dailyLessonLogLanguage==="filipino"?"Asignatura: ":"Subject: ")+subject);
      if(!values.length){
        if(context)context.remove();
        return Boolean(context);
      }
      if(!context){
        context=document.createElement("p");
        context.className="daily-lesson-log-intentions-context";
        context.contentEditable="false";
        intentionsCell.appendChild(context);
      }
      var nextText=values.join("  |  ");
      if(context.textContent===nextText)return false;
      context.textContent=nextText;
      return true;
    }
    function populateDailyLessonLogSession(sessionKey,targetSessionNumber){
      var lessonPlan=dailyLessonLogParsedSources;
      var session=lessonPlan&&lessonPlan.sessions&&lessonPlan.sessions[sessionKey];
      var content=$("dailyLessonLogDocument");
      var table=content.querySelector("table");
      if(!session||!table)return;
      var globalInfo=lessonPlan.global_info||{};
      var topicSelect=content.querySelector("select.daily-lesson-log-topic-select");
      var learningAreaSelect=content.querySelector("select.daily-lesson-log-learning-area-select");
      var updated=0;
      var skipped=0;
      if(setDailyLessonLogSourceSelect(topicSelect,globalInfo.pamagat))updated+=1;
      if(setDailyLessonLogSourceSelect(learningAreaSelect,globalInfo.larangan))updated+=1;
      if(syncDailyLessonLogIntentions(content))updated+=1;
      var globalFields=[
        {
          pattern:/^(?:mga sanggunian|references?)\b/i,
          value:globalInfo.sanggunian,
        },
        {
          pattern:/^(?:pagpapahayag ng paggamit ng ai|pahayag sa paggamit ng ai|ai use declaration|ai declaration)\b/i,
          value:globalInfo.aiDeclaration,
        },
        {
          pattern:/^(?:bilang ng mga sesyon|bilang ng sesyon|number of sessions|session count)\b/i,
          value:globalInfo.sessionCount||String(Object.keys(lessonPlan.sessions||{}).length),
        },
      ];
      globalFields.forEach(function(field){
        var row=findDailyLessonLogRow(content,field.pattern);
        var result=fillDailyLessonLogCell(row&&row.cells[1],field.value);
        if(result.changed)updated+=1;
        if(result.skipped)skipped+=1;
      });
      var standards=[
        globalInfo.contentStandard&&"Pamantayang Pangnilalaman / Content Standard: "+globalInfo.contentStandard,
        globalInfo.performanceStandard&&"Pamantayan sa Pagganap / Performance Standard: "+globalInfo.performanceStandard,
        globalInfo.learningCompetency&&"Kasanayang Pampagkatuto / Learning Competency: "+globalInfo.learningCompetency,
      ].filter(Boolean).join("\n");
      var standardsRow=findDailyLessonLogRow(content,/^(?:kasanayang pampagkatuto at pamantayan ng kurikulum|learning competency and curriculum standards)\b/i);
      var standardsResult=fillDailyLessonLogCell(standardsRow&&standardsRow.cells[1],standards);
      if(standardsResult.changed)updated+=1;
      if(standardsResult.skipped)skipped+=1;

      var sessionNumber=Number(targetSessionNumber);
      var sessionFields=[
        {pattern:/^(?:mga layuning pampagkatuto|mga layunin sa pagkatuto|learning objectives|objectives)\b/i,value:session.objectives},
        {pattern:/^(?:panimulang gawain|bago ang aralin|pre-lesson|prelesson)\b/i,value:session.preLesson},
        {pattern:/^(?:daloy(?: ng mga sesyon)?|session flow|learning flow|flow|lesson procedure)\b/i,value:session.flow},
        {pattern:/^(?:mga kagamitang panturo|mga kagamitan sa pagkatuto|learning resources|teaching materials|materials)\b/i,value:session.learningResources},
        {pattern:/^(?:mga oportunidad para sa integrasyon|oportunidad sa integrasyon|opportunities for integration|integration)\b/i,value:session.integration},
        {pattern:/^(?:pormatibong pagtataya|formative assessment|assessment)\b/i,value:session.assessment},
        {pattern:/^(?:pinalawak na oportunidad sa pagkatuto|extended learning opportunities|extended learning)\b/i,value:session.extendedLearning},
        {pattern:/^(?:pagninilay|mga pagninilay|reflections?|reflection)\b/i,value:session.reflections},
      ];
      sessionFields.forEach(function(field){
        if(!field.value)return;
        var row=findDailyLessonLogRow(content,field.pattern);
        var result=fillDailyLessonLogCell(row&&row.cells[sessionNumber],field.value);
        if(result.changed)updated+=1;
        if(result.skipped)skipped+=1;
      });
      if(updated)scheduleDailyLessonLogSave();
      setDailyLessonLogStatus(
        updated
          ?"Filled "+updated+" DLL field"+(updated===1?"":"s")+" in SESSION "+sessionNumber
            +" using source SESSION "+String(sessionKey).replace("session_","")+"."
            +(skipped?" "+skipped+" existing field"+(skipped===1?" was":"s were")+" preserved.":"")
          :"No empty matching DLL fields were found for SESSION "+sessionNumber+". Existing entries were preserved.",
        false,
      );
    }
    function initializeDailyLessonLogSourceDropdowns(content){
      var topicCell=content.querySelector("table tr:first-child td:nth-child(2)");
      var learningAreaCell=content.querySelector("table tr:nth-child(2) td:nth-child(2)");
      if(topicCell){
        var topicSelect=topicCell.querySelector("select.daily-lesson-log-topic-select");
        var selected=topicSelect?topicSelect.value:topicCell.textContent.trim();
        if(/^\(?TOPIC\)?$/i.test(selected))selected="";
        if(!topicSelect){
          topicSelect=document.createElement("select");
          topicSelect.className="daily-lesson-log-source-select daily-lesson-log-topic-select";
          topicSelect.contentEditable="false";
          topicSelect.setAttribute("aria-label","Lesson title from uploaded sources");
          topicCell.replaceChildren(topicSelect);
        }
        renderDailyLessonLogSourceDropdown(topicSelect,selected,dailyLessonLogTopicChoices,"lesson title");
      }
      if(learningAreaCell){
        var learningAreaSelect=learningAreaCell.querySelector("select.daily-lesson-log-learning-area-select");
        var learningArea=learningAreaSelect?learningAreaSelect.value:learningAreaCell.textContent.trim();
        if(/^\(?SUBJECT\)?$|^\(?LEARNING\s+AREA\)?$/i.test(learningArea))learningArea="";
        if(!learningAreaSelect){
          learningAreaSelect=document.createElement("select");
          learningAreaSelect.className="daily-lesson-log-source-select daily-lesson-log-learning-area-select";
          learningAreaSelect.contentEditable="false";
          learningAreaSelect.setAttribute("aria-label","Learning area from uploaded sources");
          learningAreaCell.replaceChildren(learningAreaSelect);
        }
        renderDailyLessonLogSourceDropdown(learningAreaSelect,learningArea,dailyLessonLogLearningAreaChoices,"learning area");
      }
    }
    function replaceDailyLessonLogSourceDropdownsWithText(content){
      content.querySelectorAll("select.daily-lesson-log-source-select").forEach(function(sourceSelect){
        var paragraph=document.createElement("p");
        var strong=document.createElement("strong");
        strong.textContent=sourceSelect.value
          ||(sourceSelect.classList.contains("daily-lesson-log-learning-area-select")?"(SUBJECT)":"(TOPIC)");
        paragraph.appendChild(strong);
        sourceSelect.replaceWith(paragraph);
      });
      content.querySelectorAll("select.daily-lesson-log-session-source-select").forEach(function(select){
        select.remove();
      });
    }
    function selectedLessonPlanSourceBytes(){
      return lessonPlanSourceFiles.reduce(function(total,source){return total+source.file.size},0);
    }
    function renderLessonPlanSources(){
      var list=$("lessonPlanSourcesList");
      list.replaceChildren();
      lessonPlanSourceFiles.forEach(function(source){
        var item=document.createElement("li");
        item.className="lesson-plan-source-item";
        var name=document.createElement("span");
        name.className="lesson-plan-source-name";
        name.textContent=source.file.name;
        var size=document.createElement("span");
        size.className="lesson-plan-source-size";
        size.textContent=formatLessonPlanSourceSize(source.file.size);
        name.appendChild(size);
        var actions=document.createElement("div");
        actions.className="lesson-plan-source-actions";
        var remove=document.createElement("button");
        remove.type="button";
        remove.className="lesson-plan-source-action lesson-plan-source-action--remove";
        remove.textContent="Remove";
        remove.disabled=lessonPlanSourcesGenerating;
        remove.setAttribute("aria-label","Remove "+source.file.name);
        remove.addEventListener("click",function(){removeLessonPlanSource(source.id)});
        actions.append(remove);
        item.append(name,actions);
        list.appendChild(item);
      });
      $("lessonPlanGenerateSources").disabled=!lessonPlanSourceFiles.length||lessonPlanSourcesGenerating;
      $("lessonPlanAddSource").disabled=lessonPlanSourcesGenerating;
      $("lessonPlanSourceFiles").disabled=lessonPlanSourcesGenerating;
      $("lessonPlanRemoveAllSources").hidden=!lessonPlanSourceFiles.length;
      $("lessonPlanRemoveAllSources").disabled=lessonPlanSourcesGenerating;
    }
    function removeLessonPlanSource(sourceId){
      lessonPlanSourceFiles=lessonPlanSourceFiles.filter(function(source){return source.id!==sourceId});
      clearLessonPlanSourcePreview();
      renderLessonPlanSources();
      setLessonPlanSourcesStatus(lessonPlanSourceFiles.length
        ?lessonPlanSourceFiles.length+" temporary source"+(lessonPlanSourceFiles.length===1?"":"s")+" selected ("+formatLessonPlanSourceSize(selectedLessonPlanSourceBytes())+" of 100 MB)."
        :"No temporary sources selected.",false);
    }
    async function addLessonPlanSources(files){
      var selectedFiles=Array.from(files||[]);
      if(!selectedFiles.length)return;
      var allowedExtensions=["pdf","doc","docx","xls","xlsx"];
      var maxTotalSourceSize=100*1024*1024;
      if(lessonPlanSourceFiles.length+selectedFiles.length>100){
        setLessonPlanSourcesStatus("Upload no more than 100 source files at a time. No files were added.",true);
        return;
      }
      if(selectedFiles.some(function(file){
        var extension=file.name.split(".").pop().toLowerCase();
        return !allowedExtensions.includes(extension)||!file.size;
      })){
        setLessonPlanSourcesStatus("Choose non-empty PDF, Word, or Excel files. No files were added.",true);
        return;
      }
      var additionalBytes=selectedFiles.reduce(function(total,file){return total+file.size},0);
      if(selectedLessonPlanSourceBytes()+additionalBytes>maxTotalSourceSize){
        setLessonPlanSourcesStatus("All selected sources must total 100 MB or less. No files were added.",true);
        return;
      }
      selectedFiles.forEach(function(file){
        lessonPlanSourceFiles.push({
          id:Date.now().toString(36)+":"+Math.random().toString(36).slice(2),
          file:file
        });
      });
      clearLessonPlanSourcePreview();
      renderLessonPlanSources();
      setLessonPlanSourcesStatus(lessonPlanSourceFiles.length+" temporary source"
        +(lessonPlanSourceFiles.length===1?"":"s")+" selected ("
        +formatLessonPlanSourceSize(selectedLessonPlanSourceBytes())+" of 100 MB).",false);
    }
    async function generateLessonPlanSourcePreview(){
      if(!lessonPlanSourceFiles.length||lessonPlanSourcesGenerating)return;
      var formData=new FormData();
      lessonPlanSourceFiles.forEach(function(source){
        formData.append("sources",source.file,source.file.name);
      });
      var controller=new AbortController();
      lessonPlanSourceGenerationController=controller;
      var timeout=window.setTimeout(function(){controller.abort()},180000);
      lessonPlanSourcesGenerating=true;
      renderLessonPlanSources();
      setLessonPlanSourcesStatus("Extracting text from the temporary sources…",false);
      try{
        var result=await api("/api/lesson-plan/source-preview",{
          method:"POST",
          body:formData,
          signal:controller.signal
        });
        $("lessonPlanSourcePreview").value=result.preview;
        $("lessonPlanSourcePreviewPanel").hidden=false;
        dailyLessonLogParsedSources=result.lessonPlan||null;
        var optionCounts=updateDailyLessonLogSourceDropdowns(result.preview,dailyLessonLogParsedSources);
        renderDailyLessonLogSessionOptions(dailyLessonLogParsedSources);
        var detectedSessions=dailyLessonLogParsedSources&&dailyLessonLogParsedSources.sessions
          ?Object.keys(dailyLessonLogParsedSources.sessions).length:0;
        var sourceStatusMessage=result.truncated
          ?"Preview generated from "+result.sourceCount+" source(s), but it was truncated to fit. The files remain temporary."
          :"Preview generated from "+result.sourceCount+" source(s). The files remain temporary.";
        sourceStatusMessage+=" "+(detectedSessions
          ?detectedSessions+" session"+(detectedSessions===1?" was":"s were")+" detected."
          :"No numbered session headings were detected; review the preview text.");
        var dropdownStatusMessage=[];
        if(optionCounts.lessonTitles){
          dropdownStatusMessage.push(optionCounts.lessonTitles+" lesson title"+(optionCounts.lessonTitles===1?" was":"s were")+" added to the DLL dropdown.");
        }else{
          dropdownStatusMessage.push("No values next to Lesson Title were found.");
        }
        if(optionCounts.learningAreas){
          dropdownStatusMessage.push(optionCounts.learningAreas+" learning area"+(optionCounts.learningAreas===1?" was":"s were")+" added to the DLL dropdown.");
        }else{
          dropdownStatusMessage.push("No Learning Area or Subject values were found.");
        }
        setLessonPlanSourcesStatus(
          sourceStatusMessage+" "+dropdownStatusMessage.join(" "),
          false,
        );
      }catch(error){
        if(!controller.signal.aborted){
          setLessonPlanSourcesStatus("Could not generate a source preview: "+error.message,true);
        }
      }finally{
        window.clearTimeout(timeout);
        if(lessonPlanSourceGenerationController===controller)lessonPlanSourceGenerationController=null;
        lessonPlanSourcesGenerating=false;
        renderLessonPlanSources();
      }
    }
    function clearTemporaryLessonPlanSources(){
      if(lessonPlanSourceGenerationController)lessonPlanSourceGenerationController.abort();
      lessonPlanSourceFiles=[];
      $("lessonPlanSourceFiles").value="";
      clearLessonPlanSourcePreview();
      renderLessonPlanSources();
      setLessonPlanSourcesStatus("No temporary sources selected.",false);
    }
    async function copyLessonPlanSourcePreview(){
      var preview=$("lessonPlanSourcePreview");
      if(!preview.value)return;
      try{
        await navigator.clipboard.writeText(preview.value);
        setLessonPlanSourcesStatus("Preview text copied. Paste the relevant parts into lesson-plan fields.",false);
      }catch(error){
        preview.focus();
        preview.select();
        setLessonPlanSourcesStatus("Copy was blocked by the browser. The preview is selected so you can copy it manually.",true);
      }
    }
    window.addEventListener("lessonPlanSourcesClear",clearTemporaryLessonPlanSources);
    window.addEventListener("lessonPlanProfileFieldsSynced",function(){
      syncDailyLessonLogProfileValues($("dailyLessonLogDocument"));
    });
    function setLessonPlanNotice(message,isError){
      $("lessonPlanNotice").textContent=message;
      $("lessonPlanNotice").classList.toggle("error",Boolean(isError));
    }
    function setDailyLessonLogStatus(message,isError){
      var status=$("dailyLessonLogStatus");
      status.textContent=message;
      status.classList.toggle("error",Boolean(isError));
    }
    function sanitizeDailyLessonLogHtml(html){
      var allowedTags=new Set([
        "A","BLOCKQUOTE","BR","EM","H1","H2","H3","H4","H5","H6","HR",
        "IMG","LI","OL","P","S","SPAN","STRONG","SUB","SUP","TABLE","TBODY",
        "TD","TFOOT","TH","THEAD","TR","U","UL"
      ]);
      var parsed=new DOMParser().parseFromString(String(html),"text/html");
      var result=document.createElement("div");
      function appendSafeNode(source,target){
        if(source.nodeType===Node.TEXT_NODE){
          target.appendChild(document.createTextNode(source.nodeValue||""));
          return;
        }
        if(source.nodeType!==Node.ELEMENT_NODE)return;
        var tag=source.tagName.toUpperCase();
        if(tag==="SCRIPT"||tag==="STYLE"||tag==="IFRAME"||tag==="OBJECT"||tag==="EMBED")return;
        if(!allowedTags.has(tag)){
          Array.from(source.childNodes).forEach(function(child){appendSafeNode(child,target)});
          return;
        }
        var clean=document.createElement(tag.toLowerCase());
        if(tag==="IMG"){
          var imageSource=source.getAttribute("src")||"";
          if(!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i.test(imageSource))return;
          clean.src=imageSource;
          clean.alt=(source.getAttribute("alt")||"").slice(0,300);
        }else if(tag==="A"){
          var href=source.getAttribute("href")||"";
          if(/^https?:\/\//i.test(href))clean.href=href;
        }else if(tag==="TD"||tag==="TH"){
          ["colspan","rowspan"].forEach(function(attribute){
            var value=Number(source.getAttribute(attribute));
            if(Number.isInteger(value)&&value>=1&&value<=20)clean.setAttribute(attribute,String(value));
          });
        }else if(tag==="TR"&&source.classList.contains("daily-lesson-log-session-row")){
          clean.className="daily-lesson-log-session-row";
        }else if(tag==="P"&&source.classList.contains("daily-lesson-log-period-summary")){
          clean.className="daily-lesson-log-period-summary";
          clean.contentEditable="false";
          clean.setAttribute("aria-label","Selected lesson period");
        }else if(tag==="P"&&source.classList.contains("daily-lesson-log-intentions-context")){
          clean.className="daily-lesson-log-intentions-context";
          clean.contentEditable="false";
        }
        Array.from(source.childNodes).forEach(function(child){appendSafeNode(child,clean)});
        target.appendChild(clean);
      }
      Array.from(parsed.body.childNodes).forEach(function(child){appendSafeNode(child,result)});
      return result;
    }
    function removeDailyLessonLogSchoolHeader(content){
      var table=content.querySelector("table");
      if(!table)return;
      var headerParagraphs=Array.from(content.querySelectorAll("p")).filter(function(paragraph){
        return Boolean(paragraph.compareDocumentPosition(table)&Node.DOCUMENT_POSITION_FOLLOWING);
      });
      var headerText=headerParagraphs.map(function(paragraph){return paragraph.textContent}).join(" ");
      if(!/Republic of the Philippines|Department of Education/i.test(headerText))return;
      headerParagraphs.forEach(function(paragraph){paragraph.remove()});
    }
    function removeDailyLessonLogSignatures(content){
      var table=content.querySelector("table");
      if(!table)return;
      var trailingParagraphs=Array.from(content.querySelectorAll("p")).filter(function(paragraph){
        return Boolean(paragraph.compareDocumentPosition(table)&Node.DOCUMENT_POSITION_PRECEDING);
      });
      var signatureIndex=trailingParagraphs.findIndex(function(paragraph){
        return /Prepared by:|Checked and Reviewed by:|Inihanda ni:|Sinuri at Nirepaso nina:/i.test(paragraph.textContent);
      });
      if(signatureIndex>=0)trailingParagraphs.slice(signatureIndex).forEach(function(paragraph){paragraph.remove()});
    }
    function lockDailyLessonLogFirstColumn(content){
      content.querySelectorAll("table tr").forEach(function(row){
        if(row.cells[0])row.cells[0].contentEditable="false";
      });
    }
    function syncDailyLessonLogProfileValues(content){
      var table=content.querySelector("table");
      if(!table)return;
      var teacherName=$("teacherProfileName").value.trim();
      var sectionSelect=$("teacherSubjectSection");
      var sectionOption=sectionSelect.options[sectionSelect.selectedIndex];
      var activeSection=sectionOption?sectionOption.textContent.trim():"";
      var changed=false;
      table.querySelectorAll("tr").forEach(function(row){
        if(!row.cells[0]||!row.cells[1])return;
        var label=row.cells[0].textContent.replace(/\s+/g," ").trim();
        var value="";
        var fallback="";
        if(/^(?:teacher(?:'s)?\s+name|pangalan ng guro)\b/i.test(label)){
          value=teacherName;
          fallback="(TEACHER’S NAME)";
        }else if(/^(?:grade(?:\s+level)?\s+(?:and\s+)?section|baitang\s+at\s+sek(?:syon|siyon))\b/i.test(label)){
          value=activeSection;
          fallback="(GRADE AND SECTION)";
        }else return;
        var cell=row.cells[1];
        var paragraph=cell.querySelector("p");
        var nextText=value||fallback;
        if(!paragraph){
          paragraph=document.createElement("p");
          cell.replaceChildren(paragraph);
        }
        if(paragraph.textContent!==nextText)changed=true;
        paragraph.textContent=nextText;
        paragraph.contentEditable="false";
      });
      if(changed&&content===$("dailyLessonLogDocument")
        &&dailyLessonLogLoadedLanguage===dailyLessonLogLanguage)scheduleDailyLessonLogSave();
    }
    function dailyLessonLogDraftKey(language){
      return lessonPlanStorageKey("daily-log-document-"+language,"daily-lesson-log");
    }
    function dailyLessonLogPeriodStorageKey(language){
      return lessonPlanStorageKey("daily-log-period-"+language,"daily-lesson-log");
    }
    function dailyLessonLogPeriodValues(){
      return {
        term:$("dailyLessonLogTerm").value,
        week:$("dailyLessonLogWeek").value,
        dateFrom:$("dailyLessonLogDateFrom").value,
        dateTo:$("dailyLessonLogDateTo").value,
        year:$("dailyLessonLogYear").value,
      };
    }
    function updateDailyLessonLogPeriodSummary(){
      var documentPanel=$("dailyLessonLogDocument");
      var table=documentPanel.querySelector("table");
      if(!table)return;
      var values=dailyLessonLogPeriodValues();
      var summary=documentPanel.querySelector(".daily-lesson-log-period-summary");
      if(!summary){
        summary=document.createElement("p");
        summary.className="daily-lesson-log-period-summary";
        summary.contentEditable="false";
        summary.setAttribute("aria-label","Selected lesson period");
        table.parentNode.insertBefore(summary,table);
      }
      summary.textContent="TERM "+values.term+"  |  WEEK "+values.week
        +"  |  DATE FROM: "+(values.dateFrom||"Not selected")
        +"  |  TO: "+(values.dateTo||"Not selected")
        +"  |  YEAR: "+values.year;
    }
    function restoreDailyLessonLogPeriod(language){
      try{
        var saved=window.localStorage.getItem(dailyLessonLogPeriodStorageKey(language));
        if(!saved)return;
        var values=JSON.parse(saved);
        if(!values||typeof values!=="object"||Array.isArray(values)){
          throw new Error("The saved lesson period has an unexpected format.");
        }
        var controls={
          term:$("dailyLessonLogTerm"),
          week:$("dailyLessonLogWeek"),
          year:$("dailyLessonLogYear"),
        };
        Object.keys(controls).forEach(function(key){
          var value=String(values[key]||"");
          if(Array.from(controls[key].options).some(function(option){return option.value===value})){
            controls[key].value=value;
          }
        });
        ["dateFrom","dateTo"].forEach(function(key){
          var value=typeof values[key]==="string"?values[key]:"";
          if(!value||/^\d{4}-\d{2}-\d{2}$/.test(value))$("dailyLessonLog"+(key==="dateFrom"?"DateFrom":"DateTo")).value=value;
        });
        $("dailyLessonLogDateTo").min=$("dailyLessonLogDateFrom").value;
        $("dailyLessonLogDateFrom").max=$("dailyLessonLogDateTo").value;
      }catch(error){
        setDailyLessonLogStatus("Could not load the saved lesson period: "+error.message,true);
      }
    }
    function saveDailyLessonLogPeriod(){
      var values=dailyLessonLogPeriodValues();
      if(values.dateFrom&&values.dateTo&&values.dateFrom>values.dateTo){
        setDailyLessonLogStatus("DATE FROM must be on or before TO.",true);
        return;
      }
      try{
        window.localStorage.setItem(
          dailyLessonLogPeriodStorageKey(dailyLessonLogLanguage),
          JSON.stringify(values),
        );
        updateDailyLessonLogPeriodSummary();
        setDailyLessonLogStatus("Lesson period saved. Changes save automatically.",false);
      }catch(error){
        setDailyLessonLogStatus("Could not save the lesson period: "+error.message,true);
      }
    }
    function initializeDailyLessonLogPeriod(){
      var currentYear=new Date().getFullYear();
      for(var week=1;week<=12;week++){
        $("dailyLessonLogWeek").add(new Option("Week "+week,String(week)));
      }
      for(var year=currentYear-5;year<=currentYear+5;year++){
        $("dailyLessonLogYear").add(new Option(String(year),String(year)));
      }
      $("dailyLessonLogYear").value=String(currentYear);
      restoreDailyLessonLogPeriod(dailyLessonLogLanguage);
      ["dailyLessonLogTerm","dailyLessonLogWeek","dailyLessonLogDateFrom","dailyLessonLogDateTo","dailyLessonLogYear"]
        .forEach(function(id){
          $(id).addEventListener("change",function(){
            $("dailyLessonLogDateTo").min=$("dailyLessonLogDateFrom").value;
            $("dailyLessonLogDateFrom").max=$("dailyLessonLogDateTo").value;
            saveDailyLessonLogPeriod();
          });
        });
    }
    function loadDailyLessonLogTemplate(language){
      language=language||dailyLessonLogLanguage;
      if(dailyLessonLogLoadedLanguage===language)return Promise.resolve();
      if(dailyLessonLogLoadingByLanguage[language])return dailyLessonLogLoadingByLanguage[language];
      var documentPanel=$("dailyLessonLogDocument");
      documentPanel.contentEditable="false";
      $("dailyLessonLogRetry").hidden=true;
      $("dailyLessonLogSave").disabled=true;
      $("dailyLessonLogExcel").disabled=true;
      $("dailyLessonLogPrint").disabled=true;
      if(language===dailyLessonLogLanguage)setDailyLessonLogStatus("Loading the five-session Daily Lesson Log template…",false);
      var loading=Promise.resolve().then(async function(){
        try{
          var saved=window.localStorage.getItem(dailyLessonLogDraftKey(language));
          var html=saved||dailyLessonLogTemplateHtml[language];
          if(!html){
            var result=await api("/api/lesson-plan/daily-log-template?language="+encodeURIComponent(language));
            if(!result||typeof result.html!=="string"||!result.html){
              throw new Error("The template response was empty.");
            }
            html=result.html;
            dailyLessonLogTemplateHtml[language]=html;
          }
          if(language!==dailyLessonLogLanguage)return;
          var safeContent=sanitizeDailyLessonLogHtml(html);
          removeDailyLessonLogSchoolHeader(safeContent);
          removeDailyLessonLogSignatures(safeContent);
          lockDailyLessonLogFirstColumn(safeContent);
          initializeDailyLessonLogSourceDropdowns(safeContent);
          renderDailyLessonLogSessionOptions(dailyLessonLogParsedSources,safeContent);
          syncDailyLessonLogIntentions(safeContent);
          syncDailyLessonLogProfileValues(safeContent);
          documentPanel.replaceChildren(safeContent);
          updateDailyLessonLogPeriodSummary();
          documentPanel.contentEditable="true";
          dailyLessonLogLoadedLanguage=language;
          $("dailyLessonLogSave").disabled=false;
          $("dailyLessonLogExcel").disabled=false;
          $("dailyLessonLogPrint").disabled=false;
          setDailyLessonLogStatus(saved
            ?"Your saved Daily Lesson Log draft is ready. Changes save automatically."
            :"Five-session Daily Lesson Log loaded from the "+(language==="filipino"?"Filipino":"English")+" Word template. Changes save automatically.",false);
        }catch(error){
          if(language===dailyLessonLogLanguage){
            setDailyLessonLogStatus("Could not load the Daily Lesson Log: "+error.message,true);
            $("dailyLessonLogRetry").hidden=false;
          }
        }finally{
          delete dailyLessonLogLoadingByLanguage[language];
        }
      });
      dailyLessonLogLoadingByLanguage[language]=loading;
      return loading;
    }
    function selectDailyLessonLogLanguage(language){
      if(language!=="filipino"&&language!=="english")return;
      if(language===dailyLessonLogLanguage){
        loadDailyLessonLogTemplate(language);
        return;
      }
      window.clearTimeout(dailyLessonLogSaveTimer);
      saveDailyLessonLogDraft();
      dailyLessonLogLoadedLanguage=null;
      dailyLessonLogLanguage=language;
      $("dailyLessonLogFilipinoTab").setAttribute("aria-pressed",String(language==="filipino"));
      $("dailyLessonLogEnglishTab").setAttribute("aria-pressed",String(language==="english"));
      restoreDailyLessonLogPeriod(language);
      loadDailyLessonLogTemplate(language);
    }
    function saveDailyLessonLogDraft(){
      if(!dailyLessonLogLoadedLanguage||dailyLessonLogLoadedLanguage!==dailyLessonLogLanguage)return;
      try{
        var draftContent=$("dailyLessonLogDocument").cloneNode(true);
        replaceDailyLessonLogSourceDropdownsWithText(draftContent);
        var safeContent=sanitizeDailyLessonLogHtml(draftContent.innerHTML);
        safeContent.querySelectorAll(".daily-lesson-log-period-summary").forEach(function(summary){summary.remove()});
        window.localStorage.setItem(dailyLessonLogDraftKey(dailyLessonLogLanguage),safeContent.innerHTML);
        setDailyLessonLogStatus("Daily Lesson Log draft saved in this browser at "
          +new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+".",false);
      }catch(error){
        setDailyLessonLogStatus("Could not save the Daily Lesson Log draft: "+error.message,true);
      }
    }
    async function downloadDailyLessonLogExcel(){
      var button=$("dailyLessonLogExcel");
      button.disabled=true;
      saveDailyLessonLogDraft();
      try{
        var content=$("dailyLessonLogDocument");
        var tables=Array.from(content.querySelectorAll("table"));
        if(!tables.length)throw new Error("The Daily Lesson Log has no table to export.");
        var rows=[];
        tables.forEach(function(table){
          Array.from(table.rows).forEach(function(tableRow){
            var cells=Array.from(tableRow.cells).map(function(cell){
              var clone=cell.cloneNode(true);
              var originalSelects=Array.from(cell.querySelectorAll("select"));
              var clonedSelects=Array.from(clone.querySelectorAll("select"));
              clonedSelects.forEach(function(select,index){
                var original=originalSelects[index];
                if(select.matches(".daily-lesson-log-session-source-select")){
                  select.remove();
                }else{
                  var selected=original&&original.options[original.selectedIndex];
                  select.replaceWith(document.createTextNode(selected?selected.textContent:select.value));
                }
              });
              return {
                text:(clone.innerText||clone.textContent||"").replace(/\u00a0/g," ").trim(),
                span:Number(cell.colSpan)||1,
              };
            });
            rows.push({
              cells:cells,
              sessionHeader:tableRow.classList.contains("daily-lesson-log-session-row"),
            });
          });
        });
        var response=await fetch("/api/lesson-plan/daily-log-export",{
          method:"POST",
          credentials:"same-origin",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            language:dailyLessonLogLanguage,
            period:dailyLessonLogPeriodValues(),
            rows:rows,
          }),
        });
        if(!response.ok){
          var errorResult=await response.json().catch(function(){return {}});
          throw new Error(errorResult.error||"Unable to export the Daily Lesson Log.");
        }
        var disposition=response.headers.get("content-disposition")||"";
        var filenameMatch=disposition.match(/filename="([^"]+)"/i);
        if(!filenameMatch)throw new Error("The server did not provide an Excel filename.");
        var objectUrl=URL.createObjectURL(await response.blob());
        var link=document.createElement("a");
        link.href=objectUrl;
        link.download=filenameMatch[1];
        link.style.display="none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
        setDailyLessonLogStatus("Daily Lesson Log downloaded as "+filenameMatch[1]+".",false);
      }catch(error){
        setDailyLessonLogStatus("Could not download the Daily Lesson Log as Excel: "+error.message,true);
      }finally{
        button.disabled=!dailyLessonLogLoadedLanguage||dailyLessonLogLoadedLanguage!==dailyLessonLogLanguage;
      }
    }
    function enableDailyLessonLogDragToScroll(container){
      var drag=null;
      function stopDragging(event){
        if(!drag||event.pointerId!==drag.pointerId)return;
        var pointerId=drag.pointerId;
        drag=null;
        container.classList.remove("is-dragging");
        if(container.hasPointerCapture(pointerId))container.releasePointerCapture(pointerId);
      }
      container.addEventListener("pointerdown",function(event){
        if(event.pointerType!=="mouse"||event.button!==0||event.isPrimary===false)return;
        if(event.target.closest("button,a,input,select,textarea,[contenteditable=true]"))return;
        if(container.scrollWidth<=container.clientWidth&&container.scrollHeight<=container.clientHeight)return;
        drag={
          pointerId:event.pointerId,
          x:event.clientX,
          y:event.clientY,
          left:container.scrollLeft,
          top:container.scrollTop,
        };
        container.setPointerCapture(event.pointerId);
        container.classList.add("is-dragging");
        event.preventDefault();
      });
      container.addEventListener("pointermove",function(event){
        if(!drag||event.pointerId!==drag.pointerId)return;
        container.scrollLeft=drag.left-(event.clientX-drag.x);
        container.scrollTop=drag.top-(event.clientY-drag.y);
      });
      ["pointerup","pointercancel","lostpointercapture"].forEach(function(eventName){
        container.addEventListener(eventName,stopDragging);
      });
    }
    function openDailyLessonLogPrintPreview(){
      if(dailyLessonLogLoadedLanguage!==dailyLessonLogLanguage)return;
      saveDailyLessonLogDraft();
      updateDailyLessonLogPeriodSummary();
      var preview=$("dailyLessonLogDocument").cloneNode(true);
      preview.removeAttribute("id");
      preview.contentEditable="false";
      replaceDailyLessonLogSourceDropdownsWithText(preview);
      $("dailyLessonLogPreviewPage").replaceChildren(preview);
      $("dailyLessonLogPreviewDialog").showModal();
    }
    function printDailyLessonLogFromPreview(){
      $("dailyLessonLogPreviewDialog").close();
      document.body.classList.add("lesson-plan-printing");
      window.print();
    }
    function scheduleDailyLessonLogSave(){
      setDailyLessonLogStatus("Saving Daily Lesson Log changes…",false);
      window.clearTimeout(dailyLessonLogSaveTimer);
      dailyLessonLogSaveTimer=window.setTimeout(saveDailyLessonLogDraft,400);
    }
    function updateLessonPlanModeView(){
      var isDailyLessonLog=lessonPlanMode==="daily-lesson-log";
      $("lessonPlanWorkspace").classList.toggle("daily-lesson-log-active",isDailyLessonLog);
      $("dailyLessonLogDocumentPanel").hidden=!isDailyLessonLog;
      if(isDailyLessonLog)loadDailyLessonLogTemplate();
    }
    function lessonPlanForms(){
      return [$("lessonPlanFilipinoForm"),$("lessonPlanEnglishForm")];
    }
    function configureLessonPlanSessionCounts(){
      var isDailyLessonLog=lessonPlanMode==="daily-lesson-log";
      lessonPlanForms().forEach(function(form){
        var count=form.elements.namedItem("sessionCount");
        if(!count)return;
        count.min=isDailyLessonLog?"2":"1";
        count.max=isDailyLessonLog?"60":"1";
        count.disabled=!isDailyLessonLog;
        var value=Number(count.value);
        if(!isDailyLessonLog)count.value="1";
        else if(!Number.isFinite(value)||value<2)count.value="2";
        else if(value>60)count.value="60";
      });
    }
    function selectLessonPlanMode(mode){
      if(mode!=="lesson-plan"&&mode!=="daily-lesson-log")return;
      if(mode===lessonPlanMode)return;
      lessonPlanForms().forEach(saveLessonPlanForm);
      lessonPlanMode=mode;
      $("lessonPlanModeSelect").value=mode;
      lessonPlanForms().forEach(function(form){
        form.reset();
        restoreLessonPlanForm(form);
      });
      configureLessonPlanSessionCounts();
      syncLessonPlanLearningAreas();
      syncEnglishLessonPlanProfileFields();
      lessonPlanForms().forEach(function(form){
        resizeLessonPlanTextareas(form);
        saveLessonPlanForm(form);
      });
      updateLessonPlanModeView();
      try{
        window.localStorage.setItem(lessonPlanModeStorageKey(),mode);
      }catch(error){
        setLessonPlanNotice("Could not save the selected lesson-plan type: "+error.message,true);
      }
    }
    function collectLessonPlanFields(form){
      var fields={};
      form.querySelectorAll("[name]").forEach(function(field){
        fields[field.name]=field.type==="checkbox"?field.checked:field.value;
      });
      return fields;
    }
    function restoreLessonPlanForm(form){
      try{
        var saved=window.localStorage.getItem(lessonPlanStorageKey(form.dataset.language,lessonPlanMode));
        if(!saved)return;
        var fields=JSON.parse(saved);
        if(!fields||typeof fields!=="object"||Array.isArray(fields)){
          throw new Error("The saved data has an unexpected format.");
        }
        form.querySelectorAll("[name]").forEach(function(field){
          if(!Object.prototype.hasOwnProperty.call(fields,field.name))return;
          var value=fields[field.name];
          if(field.type==="checkbox")field.checked=value===true;
          else if(typeof value==="string"||typeof value==="number")field.value=String(value);
          else throw new Error("A saved field has an unexpected format.");
        });
      }catch(error){
        setLessonPlanNotice("Could not load the "+form.dataset.language+" draft: "+error.message,true);
      }
    }
    function saveLessonPlanForm(form){
      try{
        window.localStorage.setItem(
          lessonPlanStorageKey(form.dataset.language,lessonPlanMode),
          JSON.stringify(collectLessonPlanFields(form)),
        );
        var savedAt=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
        setLessonPlanNotice(form.dataset.language==="filipino"
          ?"Na-save ang draft sa browser na ito sa "+savedAt+"."
          :"Draft saved in this browser at "+savedAt+".",false);
      }catch(error){
        setLessonPlanNotice("Could not save the "+form.dataset.language+" draft: "+error.message,true);
      }
    }
    function resizeLessonPlanTextarea(textarea){
      textarea.style.height="auto";
      var borderHeight=textarea.offsetHeight-textarea.clientHeight;
      textarea.style.height=Math.min(textarea.scrollHeight+borderHeight,420)+"px";
    }
    function resizeLessonPlanTextareas(form){
      form.querySelectorAll("textarea").forEach(resizeLessonPlanTextarea);
    }
    function selectLessonPlanLanguage(index,focus){
      var tabs=[$("lessonPlanFilipinoTab"),$("lessonPlanEnglishTab")];
      var panels=[$("lessonPlanFilipinoPanel"),$("lessonPlanEnglishPanel")];
      tabs.forEach(function(tab,tabIndex){
        var selected=tabIndex===index;
        tab.setAttribute("aria-selected",String(selected));
        tab.tabIndex=selected?0:-1;
        panels[tabIndex].hidden=!selected;
      });
      resizeLessonPlanTextareas(panels[index].querySelector(".lesson-plan-form"));
      if(focus)tabs[index].focus();
    }
    function initializeLessonPlan(){
      if(lessonPlanInitialized)return;
      try{
        var savedMode=window.localStorage.getItem(lessonPlanModeStorageKey());
        if(savedMode==="daily-lesson-log")lessonPlanMode=savedMode;
      }catch(error){
        setLessonPlanNotice("Could not load the selected lesson-plan type: "+error.message,true);
      }
      $("lessonPlanModeSelect").value=lessonPlanMode;
      $("lessonPlanModeSelect").addEventListener("change",function(){selectLessonPlanMode(this.value)});
      $("dailyLessonLogRetry").addEventListener("click",function(){loadDailyLessonLogTemplate()});
      $("dailyLessonLogFilipinoTab").addEventListener("click",function(){selectDailyLessonLogLanguage("filipino")});
      $("dailyLessonLogEnglishTab").addEventListener("click",function(){selectDailyLessonLogLanguage("english")});
      $("dailyLessonLogSave").addEventListener("click",saveDailyLessonLogDraft);
      $("dailyLessonLogExcel").addEventListener("click",downloadDailyLessonLogExcel);
      $("dailyLessonLogPrint").addEventListener("click",openDailyLessonLogPrintPreview);
      $("dailyLessonLogPreviewClose").addEventListener("click",function(){
        $("dailyLessonLogPreviewDialog").close();
      });
      $("dailyLessonLogPreviewCancel").addEventListener("click",function(){
        $("dailyLessonLogPreviewDialog").close();
      });
      $("dailyLessonLogPreviewPrint").addEventListener("click",printDailyLessonLogFromPreview);
      enableDailyLessonLogDragToScroll($("dailyLessonLogPreviewContent"));
      $("dailyLessonLogPreviewDialog").addEventListener("click",function(event){
        if(event.target===$("dailyLessonLogPreviewDialog"))this.close();
      });
      $("dailyLessonLogDocument").addEventListener("input",scheduleDailyLessonLogSave);
      $("dailyLessonLogDocument").addEventListener("change",function(event){
        if(event.target.matches(".daily-lesson-log-session-source-select")){
          var targetCell=event.target.closest("td");
          if(targetCell&&event.target.value){
            populateDailyLessonLogSession(event.target.value,targetCell.cellIndex);
          }
        }else if(event.target.matches(".daily-lesson-log-source-select")){
          syncDailyLessonLogIntentions($("dailyLessonLogDocument"));
          scheduleDailyLessonLogSave();
        }
      });
      $("lessonPlanAddSource").addEventListener("click",function(){
        $("lessonPlanSourceFiles").click();
      });
      $("lessonPlanSourceFiles").addEventListener("change",function(){
        var input=this;
        addLessonPlanSources(input.files).finally(function(){input.value=""});
      });
      $("lessonPlanGenerateSources").addEventListener("click",generateLessonPlanSourcePreview);
      $("lessonPlanRemoveAllSources").addEventListener("click",clearTemporaryLessonPlanSources);
      $("lessonPlanCopySourcePreview").addEventListener("click",copyLessonPlanSourcePreview);
      $("lessonPlanClearSourcePreview").addEventListener("click",function(){
        clearLessonPlanSourcePreview();
        setLessonPlanSourcesStatus("Preview cleared. Selected files remain temporary until removed or the page closes.",false);
      });
      renderLessonPlanSources();
      var forms=lessonPlanForms();
      syncLessonPlanLearningAreas();
      forms.forEach(function(form){
        restoreLessonPlanForm(form);
        if(form.dataset.language==="english")syncEnglishLessonPlanProfileFields();
        resizeLessonPlanTextareas(form);
        form.addEventListener("input",function(event){
          if(event.target.matches("textarea"))resizeLessonPlanTextarea(event.target);
          saveLessonPlanForm(form);
        });
        form.addEventListener("change",function(event){
          if(event.target.name==="sessionCount")configureLessonPlanSessionCounts();
          saveLessonPlanForm(form);
        });
        form.querySelector("[data-lesson-plan-save]").addEventListener("click",function(){
          saveLessonPlanForm(form);
        });
        window.addEventListener("resize",function(){
          var activePanel=$("lessonPlanFilipinoPanel").hidden
            ?$("lessonPlanEnglishPanel")
            :$("lessonPlanFilipinoPanel");
          resizeLessonPlanTextareas(activePanel.querySelector(".lesson-plan-form"));
        });
        form.querySelector("[data-lesson-plan-print]").addEventListener("click",function(){
          saveLessonPlanForm(form);
          document.body.classList.add("lesson-plan-printing");
          window.print();
        });
      });
      configureLessonPlanSessionCounts();
      initializeDailyLessonLogPeriod();
      updateLessonPlanModeView();
      var tabs=[$("lessonPlanFilipinoTab"),$("lessonPlanEnglishTab")];
      tabs.forEach(function(tab,index){
        tab.addEventListener("click",function(){selectLessonPlanLanguage(index,false)});
        tab.addEventListener("keydown",function(event){
          var next=index;
          if(event.key==="ArrowRight")next=(index+1)%tabs.length;
          else if(event.key==="ArrowLeft")next=(index+tabs.length-1)%tabs.length;
          else if(event.key==="Home")next=0;
          else if(event.key==="End")next=tabs.length-1;
          else return;
          event.preventDefault();
          selectLessonPlanLanguage(next,true);
        });
      });
      window.addEventListener("afterprint",function(){document.body.classList.remove("lesson-plan-printing")});
      lessonPlanInitialized=true;
    }
    var calendarState={
      initialized:false,
      loading:false,
      currentDate:new Date(),
      view:"month",
      tasks:[],
      holidays:[],
      schoolCalendar:null,
      schoolCalendarRequest:null,
      loadedHolidayYear:null,
      profileDistrict:"",
      loadSequence:0,
      activeTaskId:null,
      selectedDate:""
    };
    var calendarGrid=$("teacherCalendarGrid");
    var calendarDialog=$("teacherCalendarEventDialog");
    var calendarClockTimer=null;
    var miniCalendarDate=new Date();
    miniCalendarDate.setDate(1);
    miniCalendarDate.setHours(12,0,0,0);
    var miniCalendarSelectedDate=calendarDateIso(new Date());
    var miniCalendarToggle=$("topbarCalendarToggle");
    var miniCalendarPopover=$("topbarCalendarPopover");
    var miniCalendarResizeHandle=$("topbarCalendarResizeHandle");
    var miniCalendarDrag=null;
    var miniCalendarResize=null;
    var miniCalendarHasCustomPosition=false;
    var miniCalendarGrid=$("topbarMiniCalendarGrid");
    var miniCalendarHolidayCache=new Map();
    var miniCalendarHolidayRequests=new Map();
    var miniCalendarHolidays=[];
    var miniCalendarHolidayYear=null;
    var miniCalendarTasks=[];
    var miniCalendarTaskRangeKey=null;
    var miniCalendarTaskCache=new Map();
    var miniCalendarTaskRequests=new Map();
    var miniCalendarTaskRequestSequence=0;
    var miniCalendarTaskStatusMessage="Sign in to sync calendar tasks.";
    var miniCalendarTaskStatusError=false;
    var deadlineTasks=[];
    var deadlineRefreshTimer=null;
    var deadlineRefreshSequence=0;

    function calendarDateIso(date){
      return date.getFullYear()+"-"+String(date.getMonth()+1).padStart(2,"0")+"-"+String(date.getDate()).padStart(2,"0");
    }
    function calendarDateFromIso(value){
      var parts=value.split("-").map(Number);
      return new Date(parts[0],parts[1]-1,parts[2],12);
    }
    function calendarDateLabel(date,options){
      return new Intl.DateTimeFormat("en-PH",options).format(date);
    }
    function topbarMiniCalendarVisibleRange(){
      var firstVisibleDate=new Date(miniCalendarDate.getFullYear(),miniCalendarDate.getMonth(),1,12);
      firstVisibleDate.setDate(firstVisibleDate.getDate()-firstVisibleDate.getDay());
      var lastVisibleDate=new Date(firstVisibleDate);
      lastVisibleDate.setDate(lastVisibleDate.getDate()+41);
      var from=calendarDateIso(firstVisibleDate);
      var to=calendarDateIso(lastVisibleDate);
      return {from:from,to:to,key:from+"|"+to};
    }
    function renderTopbarMiniCalendar(){
      var firstOfMonth=new Date(miniCalendarDate.getFullYear(),miniCalendarDate.getMonth(),1,12);
      var visibleRange=topbarMiniCalendarVisibleRange();
      var firstVisibleDate=calendarDateFromIso(visibleRange.from);
      var deadlinesByDate=new Map();
      var tasksByDate=new Map();
      var holidaysByDate=new Map();
      deadlineTasks.forEach(function(task){
        if(!deadlinesByDate.has(task.date))deadlinesByDate.set(task.date,[]);
        deadlinesByDate.get(task.date).push(task);
      });
      var visibleTasks=miniCalendarTaskRangeKey===visibleRange.key?miniCalendarTasks:[];
      visibleTasks.forEach(function(task){
        if(!tasksByDate.has(task.date))tasksByDate.set(task.date,[]);
        tasksByDate.get(task.date).push(task);
      });
      var selectedMunicipality=$("teacherCalendarMunicipality").value;
      if(miniCalendarHolidayYear===miniCalendarDate.getFullYear()){
        miniCalendarHolidays.forEach(function(holiday){
          if(holiday.municipality&&selectedMunicipality&&holiday.municipality!==selectedMunicipality)return;
          if(!holidaysByDate.has(holiday.date))holidaysByDate.set(holiday.date,[]);
          holidaysByDate.get(holiday.date).push(holiday);
        });
      }
      $("topbarMiniCalendarMonth").textContent=calendarDateLabel(firstOfMonth,{month:"long",year:"numeric"});
      miniCalendarGrid.replaceChildren();
      for(var dayOffset=0;dayOffset<42;dayOffset++){
        var date=new Date(firstVisibleDate);
        date.setDate(date.getDate()+dayOffset);
        var dateIso=calendarDateIso(date);
        var dayButton=document.createElement("button");
        dayButton.className="topbar-calendar-day";
        dayButton.type="button";
        dayButton.textContent=String(date.getDate());
        dayButton.setAttribute("role","gridcell");
        var dateLabel=calendarDateLabel(date,{weekday:"long",month:"long",day:"numeric",year:"numeric"});
        var dateTasks=tasksByDate.get(dateIso)||[];
        var dateDeadlines=deadlinesByDate.get(dateIso)||[];
        var dateHolidays=holidaysByDate.get(dateIso)||[];
        var dateDetails=[];
        if(dateHolidays.length){
          dayButton.classList.add("has-holiday");
          if(dateHolidays.some(function(holiday){return holiday.kind==="official"}))dayButton.classList.add("is-official-holiday");
          if(dateHolidays.some(function(holiday){return holiday.kind==="local"}))dayButton.classList.add("is-local-holiday");
          dateHolidays.forEach(function(holiday){
            dateDetails.push((holiday.kind==="local"?"Local holiday: ":"Official holiday: ")+holiday.title);
          });
        }
        if(dateTasks.length){
          dayButton.classList.add("has-task");
          var taskDetails=dateTasks.map(function(task){return (task.isDone?"Done: ":"")+task.title});
          dateDetails.push(dateTasks.length+" task"+(dateTasks.length===1?"":"s")+": "+taskDetails.join(", "));
        }
        if(dateDeadlines.length)dateDetails.push(dateDeadlines.length+" pending deadline"+(dateDeadlines.length===1?"":"s"));
        dayButton.setAttribute("aria-label",dateLabel+(dateDetails.length?"; "+dateDetails.join("; "):""));
        dayButton.setAttribute("aria-pressed",String(dateIso===miniCalendarSelectedDate));
        if(date.getMonth()!==miniCalendarDate.getMonth())dayButton.classList.add("is-outside-month");
        if(dateIso===miniCalendarSelectedDate)dayButton.classList.add("is-selected");
        if(dateIso===calendarDateIso(new Date()))dayButton.setAttribute("aria-current","date");
        var dateTitles=[];
        if(dateTasks.length)dateTitles.push(dateTasks.map(function(task){return (task.isDone?"Done: ":"")+task.title}).join("; "));
        if(dateHolidays.length)dateTitles.push(dateHolidays.map(function(holiday){
          return (holiday.kind==="local"?"Local: ":"Official: ")+holiday.title;
        }).join("; "));
        if(dateDeadlines.length){
          dayButton.classList.add("has-deadline");
          var daysRemaining=calendarDeadlineDaysRemaining(dateIso);
          if(daysRemaining<0)dayButton.classList.add("is-overdue");
          else if(daysRemaining===0)dayButton.classList.add("is-due-today");
          dateTitles.push(dateDeadlines.length+" pending task"+(dateDeadlines.length===1?"":"s")+" due "+calendarDeadlineLabel(daysRemaining).toLowerCase());
        }
        if(dateTitles.length)dayButton.title=dateTitles.join("; ");
        dayButton.addEventListener("click",function(selectedDate){return function(){
          miniCalendarSelectedDate=selectedDate;
          miniCalendarDate=calendarDateFromIso(selectedDate);
          miniCalendarDate.setDate(1);
          renderTopbarMiniCalendar();
          syncTopbarCalendarHolidays(miniCalendarDate.getFullYear());
          syncTopbarMiniCalendarTasks();
        }}(dateIso));
        miniCalendarGrid.appendChild(dayButton);
      }
      renderTopbarCalendarTasks();
    }
    function renderTopbarCalendarTasks(statusMessage,isError){
      var taskList=$("topbarMiniCalendarTaskList");
      var taskStatus=$("topbarMiniCalendarTaskStatus");
      var visibleRange=topbarMiniCalendarVisibleRange();
      var selectedTasks=miniCalendarTaskRangeKey===visibleRange.key
        ?miniCalendarTasks.filter(function(task){return task.date===miniCalendarSelectedDate})
        :[];
      taskList.replaceChildren();
      selectedTasks.forEach(function(task){
        var item=document.createElement("li");
        item.className="topbar-calendar-task-item"+(task.isDone?" is-done":"");
        var title=document.createElement("span");
        title.className="topbar-calendar-task-title";
        title.textContent=(task.isDone?"Done: ":"")+task.title;
        item.appendChild(title);
        if(task.startTime){
          var time=document.createElement("time");
          time.className="topbar-calendar-task-time";
          time.textContent=task.startTime+(task.endTime?"–"+task.endTime:"");
          item.appendChild(time);
        }
        taskList.appendChild(item);
      });
      if(typeof statusMessage==="string"){
        miniCalendarTaskStatusMessage=statusMessage;
        miniCalendarTaskStatusError=Boolean(isError);
      }else if(!miniCalendarTaskStatusError){
        miniCalendarTaskStatusMessage=miniCalendarTaskRangeKey===visibleRange.key
          ?(selectedTasks.length
            ?selectedTasks.length+" task"+(selectedTasks.length===1?"":"s")+" on "+calendarDateLabel(calendarDateFromIso(miniCalendarSelectedDate),{month:"short",day:"numeric"})+"."
            :"No tasks scheduled for this date.")
          :"Loading tasks for the visible dates…";
      }
      taskStatus.textContent=miniCalendarTaskStatusMessage;
      taskStatus.classList.toggle("error",miniCalendarTaskStatusError);
    }
    function syncTopbarMiniCalendarTasks(forceRefresh){
      if(!currentUser||currentUser.role!=="teacher"){
        renderTopbarCalendarTasks("Sign in to sync calendar tasks.");
        return Promise.resolve();
      }
      var range=topbarMiniCalendarVisibleRange();
      var requestSequence=++miniCalendarTaskRequestSequence;
      if(forceRefresh)miniCalendarTaskRequests.delete(range.key);
      if(miniCalendarTaskCache.has(range.key)&&!forceRefresh){
        miniCalendarTasks=miniCalendarTaskCache.get(range.key);
        miniCalendarTaskRangeKey=range.key;
        miniCalendarTaskStatusError=false;
        renderTopbarMiniCalendar();
        return Promise.resolve();
      }
      if(miniCalendarTaskRangeKey!==range.key){
        miniCalendarTasks=[];
        miniCalendarTaskRangeKey=null;
      }
      miniCalendarTaskStatusError=false;
      miniCalendarTaskStatusMessage="Loading tasks for the visible dates…";
      renderTopbarMiniCalendar();
      var request=miniCalendarTaskRequests.get(range.key);
      if(!request){
        request=api("/api/teacher-calendar/events?from="+encodeURIComponent(range.from)
          +"&to="+encodeURIComponent(range.to)).then(function(tasks){
          if(!Array.isArray(tasks))throw new Error("The task response is invalid.");
          return tasks;
        }).finally(function(){
          if(miniCalendarTaskRequests.get(range.key)===request)miniCalendarTaskRequests.delete(range.key);
        });
        miniCalendarTaskRequests.set(range.key,request);
      }
      return request.then(function(tasks){
        if(requestSequence!==miniCalendarTaskRequestSequence)return;
        miniCalendarTaskCache.set(range.key,tasks);
        miniCalendarTasks=tasks;
        miniCalendarTaskRangeKey=range.key;
        miniCalendarTaskStatusError=false;
        renderTopbarMiniCalendar();
      }).catch(function(error){
        if(requestSequence!==miniCalendarTaskRequestSequence)return;
        miniCalendarTasks=[];
        miniCalendarTaskRangeKey=range.key;
        renderTopbarMiniCalendar();
        renderTopbarCalendarTasks("Tasks could not be loaded. "+error.message,true);
      });
    }
    function invalidateTopbarMiniCalendarTasks(){
      miniCalendarTaskRequestSequence++;
      miniCalendarTaskCache.clear();
      miniCalendarTaskRequests.clear();
      miniCalendarTaskRangeKey=null;
      miniCalendarTasks=[];
      miniCalendarTaskStatusError=false;
      if(miniCalendarPopover.hidden){
        renderTopbarCalendarTasks("Open the mini calendar to sync tasks.");
      }else{
        syncTopbarMiniCalendarTasks(true);
      }
    }
    function renderTopbarCalendarHolidays(statusMessage,isError){
      var holidayList=$("topbarCalendarHolidayList");
      var holidayStatus=$("topbarCalendarHolidayStatus");
      var selectedMunicipality=$("teacherCalendarMunicipality").value;
      var monthPrefix=miniCalendarDate.getFullYear()+"-"+String(miniCalendarDate.getMonth()+1).padStart(2,"0")+"-";
      var monthHolidays=miniCalendarHolidayYear===miniCalendarDate.getFullYear()
        ?miniCalendarHolidays.filter(function(holiday){
          return holiday.date.indexOf(monthPrefix)===0
            &&(!holiday.municipality||!selectedMunicipality||holiday.municipality===selectedMunicipality);
        })
        :[];
      holidayList.replaceChildren();
      monthHolidays.forEach(function(holiday){
        var item=document.createElement("li");
        item.className="topbar-calendar-holiday";
        item.title=holiday.holidayType+"; "+holiday.sourceName;
        var date=document.createElement("span");
        date.className="topbar-calendar-holiday-date";
        date.textContent=calendarDateLabel(calendarDateFromIso(holiday.date),{month:"short",day:"numeric"});
        var title=document.createElement("span");
        title.className="topbar-calendar-holiday-title";
        title.textContent=holiday.title;
        var kind=document.createElement("span");
        kind.className="topbar-calendar-holiday-kind"+(holiday.kind==="local"?" is-local":"");
        kind.textContent=holiday.kind==="local"?"Local":"Official";
        item.append(date,title,kind);
        holidayList.appendChild(item);
      });
      if(statusMessage){
        holidayStatus.textContent=statusMessage;
      }else if(monthHolidays.length){
        holidayStatus.textContent=monthHolidays.length+" official and local holiday"+(monthHolidays.length===1?"":"s")+" this month.";
      }else{
        holidayStatus.textContent="No holidays listed for this month.";
      }
      holidayStatus.classList.toggle("error",Boolean(isError));
      renderTopbarMiniCalendar();
    }
    function syncTopbarCalendarHolidays(year){
      if(miniCalendarHolidayCache.has(year)){
        miniCalendarHolidays=miniCalendarHolidayCache.get(year);
        miniCalendarHolidayYear=year;
        renderTopbarCalendarHolidays();
        return Promise.resolve();
      }
      if(calendarState.loadedHolidayYear===year){
        miniCalendarHolidays=calendarState.holidays;
        miniCalendarHolidayCache.set(year,miniCalendarHolidays);
        miniCalendarHolidayYear=year;
        renderTopbarCalendarHolidays();
        return Promise.resolve();
      }
      if(miniCalendarHolidayRequests.has(year))return miniCalendarHolidayRequests.get(year);
      $("topbarCalendarHolidayStatus").textContent="Syncing official and local holidays…";
      $("topbarCalendarHolidayStatus").classList.remove("error");
      var holidayRequest=api("/api/teacher-calendar/holidays?year="+year).then(function(bundle){
        miniCalendarHolidayCache.set(year,bundle.holidays);
        if(miniCalendarDate.getFullYear()!==year)return;
        miniCalendarHolidays=bundle.holidays;
        miniCalendarHolidayYear=year;
        var sourceMessage=bundle.sync.national.warning
          ||"Official: "+bundle.sync.national.sourceName+". Local: "+bundle.sync.local.sourceName+".";
        renderTopbarCalendarHolidays(sourceMessage,false);
      }).catch(function(error){
        if(miniCalendarDate.getFullYear()!==year)return;
        miniCalendarHolidays=[];
        miniCalendarHolidayYear=year;
        renderTopbarCalendarHolidays("Holidays could not be loaded. "+error.message,true);
      }).finally(function(){
        miniCalendarHolidayRequests.delete(year);
      });
      miniCalendarHolidayRequests.set(year,holidayRequest);
      return holidayRequest;
    }
    function closeTopbarMiniCalendar(restoreFocus){
      miniCalendarPopover.hidden=true;
      miniCalendarToggle.setAttribute("aria-expanded","false");
      if(restoreFocus)miniCalendarToggle.focus();
    }
    function setTopbarMiniCalendarPosition(left,top){
      var positionParent=miniCalendarPopover.offsetParent;
      var parentBounds=positionParent?positionParent.getBoundingClientRect():{left:0,top:0};
      miniCalendarPopover.style.left=(left-parentBounds.left)+"px";
      miniCalendarPopover.style.top=(top-parentBounds.top)+"px";
    }
    function keepTopbarMiniCalendarInViewport(){
      var bounds=miniCalendarPopover.getBoundingClientRect();
      var left=Math.max(8,Math.min(bounds.left,window.innerWidth-bounds.width-8));
      var top=Math.max(8,Math.min(bounds.top,window.innerHeight-bounds.height-8));
      setTopbarMiniCalendarPosition(left,top);
    }
    function syncTopbarMiniCalendarResizeHandle(width){
      var maxWidth=Math.max(1,window.innerWidth-16);
      var minWidth=Math.min(280,maxWidth);
      miniCalendarResizeHandle.setAttribute("aria-valuemin",String(minWidth));
      miniCalendarResizeHandle.setAttribute("aria-valuemax",String(maxWidth));
      miniCalendarResizeHandle.setAttribute("aria-valuenow",String(Math.round(width)));
      miniCalendarResizeHandle.setAttribute("aria-valuetext",Math.round(width)+" pixels wide");
    }
    function setTopbarMiniCalendarWidth(width,right){
      var maxWidth=Math.max(1,window.innerWidth-16);
      var minWidth=Math.min(280,maxWidth);
      var nextWidth=Math.min(maxWidth,Math.max(minWidth,width));
      var rightEdge=Math.min(window.innerWidth-8,Math.max(minWidth+8,right));
      var bounds=miniCalendarPopover.getBoundingClientRect();
      miniCalendarPopover.style.width=nextWidth+"px";
      setTopbarMiniCalendarPosition(rightEdge-nextWidth,bounds.top);
      keepTopbarMiniCalendarInViewport();
      syncTopbarMiniCalendarResizeHandle(miniCalendarPopover.getBoundingClientRect().width);
    }
    function positionTopbarMiniCalendar(){
      var bounds=miniCalendarPopover.getBoundingClientRect();
      if(!miniCalendarHasCustomPosition){
        miniCalendarPopover.style.position="fixed";
        miniCalendarPopover.style.right="auto";
        miniCalendarPopover.style.width=bounds.width+"px";
        miniCalendarPopover.style.height=bounds.height+"px";
        miniCalendarHasCustomPosition=true;
      }
      keepTopbarMiniCalendarInViewport();
      syncTopbarMiniCalendarResizeHandle(miniCalendarPopover.getBoundingClientRect().width);
    }
    function calendarDeadlineDaysRemaining(date){
      var todayIso=calendarDateIso(new Date());
      return Math.round((Date.parse(date+"T00:00:00.000Z")-Date.parse(todayIso+"T00:00:00.000Z"))/86400000);
    }
    function calendarDeadlineLabel(daysRemaining){
      if(daysRemaining<0)return "Overdue by "+Math.abs(daysRemaining)+" day"+(Math.abs(daysRemaining)===1?"":"s");
      if(daysRemaining===0)return "Due today";
      return daysRemaining+" day"+(daysRemaining===1?"":"s")+" left";
    }
    function renderTopbarDeadlineTasks(statusMessage,isError){
      var deadlineList=$("topbarDeadlineList");
      var deadlineStatus=$("topbarDeadlineStatus");
      var badge=$("topbarCalendarBadge");
      var count=deadlineTasks.length;
      badge.hidden=count===0;
      badge.textContent=count>99?"99+":String(count);
      miniCalendarToggle.setAttribute("aria-label",count
        ?"Open mini calendar, "+count+" pending deadline"+(count===1?"":"s")
        :"Open mini calendar");
      miniCalendarToggle.title=count
        ?count+" pending deadline"+(count===1?"":"s")+" within 3 days or overdue"
        :"Open mini calendar";
      deadlineList.replaceChildren();
      deadlineTasks.forEach(function(task){
        var daysRemaining=calendarDeadlineDaysRemaining(task.date);
        var listItem=document.createElement("li");
        listItem.className="topbar-calendar-deadline";
        var taskTitle=document.createElement("strong");
        taskTitle.className="topbar-calendar-deadline-title";
        taskTitle.textContent=task.title;
        var taskDate=document.createElement("span");
        taskDate.className="topbar-calendar-deadline-date";
        taskDate.textContent=calendarDateLabel(calendarDateFromIso(task.date),{
          weekday:"short",month:"short",day:"numeric",year:"numeric"
        })+(task.startTime?" · "+task.startTime+(task.endTime?"–"+task.endTime:""):"");
        var urgency=document.createElement("span");
        urgency.className="topbar-calendar-deadline-urgency";
        urgency.textContent=calendarDeadlineLabel(daysRemaining);
        if(daysRemaining<=0)urgency.classList.add(daysRemaining<0?"is-overdue":"is-due-today");
        var actions=document.createElement("div");
        actions.className="topbar-calendar-task-actions";
        var completeButton=document.createElement("button");
        completeButton.className="btn topbar-calendar-task-complete";
        completeButton.type="button";
        completeButton.textContent="Mark done";
        completeButton.setAttribute("aria-label","Mark "+task.title+" done");
        completeButton.addEventListener("click",function(selectedTask,button){return async function(){
          button.disabled=true;
          try{
            await api("/api/teacher-calendar/events/"+encodeURIComponent(selectedTask.id),{
              method:"PATCH",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({isDone:true})
            });
            deadlineRefreshSequence++;
            deadlineTasks=deadlineTasks.filter(function(item){return item.id!==selectedTask.id});
            renderTopbarDeadlineTasks();
            invalidateTopbarMiniCalendarTasks();
            if($("toolsSelector").value==="calendarPanel")loadTeacherCalendar();
            var nextAction=deadlineList.querySelector(".topbar-calendar-task-complete");
            if(nextAction)nextAction.focus();
            else $("topbarMiniCalendarClose").focus();
          }catch(error){
            var status=$("topbarDeadlineStatus");
            status.textContent="Could not mark this task done. "+error.message;
            status.classList.add("error");
            button.disabled=false;
          }
        }}(task,completeButton));
        var rescheduleButton=document.createElement("button");
        rescheduleButton.className="btn ghost";
        rescheduleButton.type="button";
        rescheduleButton.textContent="Reschedule";
        rescheduleButton.setAttribute("aria-label","Reschedule "+task.title);
        rescheduleButton.addEventListener("click",function(selectedTask){return function(){
          openTopbarDeadlineTaskForRescheduling(selectedTask);
        }}(task));
        actions.append(completeButton,rescheduleButton);
        listItem.append(taskTitle,taskDate,urgency,actions);
        deadlineList.appendChild(listItem);
      });
      if(statusMessage){
        deadlineStatus.textContent=statusMessage;
      }else if(count){
        deadlineStatus.textContent=count+" pending task"+(count===1?"":"s")+" due today, within 3 days, or overdue.";
      }else{
        deadlineStatus.textContent="No overdue tasks or deadlines within the next 3 days.";
      }
      deadlineStatus.classList.toggle("error",Boolean(isError));
      renderTopbarMiniCalendar();
    }
    async function refreshTopbarDeadlineTasks(){
      if(!currentUser||currentUser.role!=="teacher")return;
      var requestSequence=++deadlineRefreshSequence;
      var today=new Date();
      today.setHours(12,0,0,0);
      var rangeStart=new Date(today);
      rangeStart.setDate(rangeStart.getDate()-366);
      var rangeEnd=new Date(today);
      rangeEnd.setDate(rangeEnd.getDate()+3);
      $("topbarDeadlineStatus").textContent="Checking for pending deadlines…";
      $("topbarDeadlineStatus").classList.remove("error");
      try{
        var tasks=await api("/api/teacher-calendar/events?from="+encodeURIComponent(calendarDateIso(rangeStart))
          +"&to="+encodeURIComponent(calendarDateIso(rangeEnd)));
        if(requestSequence!==deadlineRefreshSequence)return;
        deadlineTasks=tasks.filter(function(task){
          return !task.isDone&&calendarDeadlineDaysRemaining(task.date)<=3;
        });
        renderTopbarDeadlineTasks();
      }catch(error){
        if(requestSequence!==deadlineRefreshSequence)return;
        renderTopbarDeadlineTasks("Deadlines could not be loaded. "+error.message,true);
      }
    }
    window.startTeacherCalendarDeadlineNotifications=function(){
      if(deadlineRefreshTimer)window.clearInterval(deadlineRefreshTimer);
      refreshTopbarDeadlineTasks();
      deadlineRefreshTimer=window.setInterval(function(){
        refreshTopbarDeadlineTasks();
        if(!miniCalendarPopover.hidden)syncTopbarMiniCalendarTasks(true);
      },5*60*1000);
    };
    window.stopTeacherCalendarDeadlineNotifications=function(){
      deadlineRefreshSequence++;
      if(deadlineRefreshTimer)window.clearInterval(deadlineRefreshTimer);
      deadlineRefreshTimer=null;
      deadlineTasks=[];
      miniCalendarTaskRequestSequence++;
      miniCalendarTaskCache.clear();
      miniCalendarTaskRequests.clear();
      miniCalendarTaskRangeKey=null;
      miniCalendarTasks=[];
      miniCalendarTaskStatusError=false;
      renderTopbarDeadlineTasks("Sign in to see pending deadlines.");
      renderTopbarCalendarTasks("Sign in to sync calendar tasks.");
    };
    function calendarVisibleRange(){
      var start;
      var end;
      if(calendarState.view==="week"){
        start=new Date(calendarState.currentDate);
        start.setDate(start.getDate()-start.getDay());
        start.setHours(12,0,0,0);
        end=new Date(start);
        end.setDate(end.getDate()+6);
      }else{
        start=new Date(calendarState.currentDate.getFullYear(),calendarState.currentDate.getMonth(),1,12);
        start.setDate(start.getDate()-start.getDay());
        end=new Date(start);
        end.setDate(end.getDate()+41);
      }
      return {start:start,end:end,from:calendarDateIso(start),to:calendarDateIso(end)};
    }
    function calendarPeriodLabel(range){
      if(calendarState.view==="month"){
        return calendarDateLabel(calendarState.currentDate,{month:"long",year:"numeric"});
      }
      var startLabel=calendarDateLabel(range.start,{month:"short",day:"numeric"});
      var endLabel=calendarDateLabel(range.end,{month:"short",day:"numeric",year:"numeric"});
      return startLabel+" – "+endLabel;
    }
    function loadTeacherSchoolCalendar(){
      if(calendarState.schoolCalendar)return Promise.resolve(calendarState.schoolCalendar);
      if(!calendarState.schoolCalendarRequest){
        calendarState.schoolCalendarRequest=api("/api/teacher-calendar/school-year").then(function(schedule){
          if(!schedule||!Array.isArray(schedule.terms)||!Array.isArray(schedule.activities)){
            throw new Error("The DepEd school-calendar response is invalid.");
          }
          calendarState.schoolCalendar=schedule;
          renderTeacherCalendarSchoolYear(schedule);
          return schedule;
        }).catch(function(error){
          calendarState.schoolCalendarRequest=null;
          throw error;
        });
      }
      return calendarState.schoolCalendarRequest;
    }
    function calendarSchoolYearDateRange(startDate,endDate,includeStartYear){
      var startOptions={month:"short",day:"numeric"};
      if(includeStartYear)startOptions.year="numeric";
      var start=calendarDateLabel(calendarDateFromIso(startDate),startOptions);
      var end=calendarDateLabel(calendarDateFromIso(endDate),{month:"short",day:"numeric",year:"numeric"});
      return start+" – "+end;
    }
    function calendarSchoolActivityDates(activity){
      if(Array.isArray(activity.dates))return activity.dates;
      var currentDate=calendarDateFromIso(activity.date);
      var endDate=calendarDateFromIso(activity.endDate||activity.date);
      var dates=[];
      while(currentDate<=endDate){
        dates.push(calendarDateIso(currentDate));
        currentDate.setDate(currentDate.getDate()+1);
      }
      return dates;
    }
    function calendarSchoolActivityIndicators(activities){
      var block=activities.find(function(activity){
        return activity.kind==="opening-block"
          ||activity.kind==="instructional-block"
          ||activity.kind==="end-of-term-block";
      });
      var assessment=activities.find(function(activity){return activity.kind==="examination"})
        ||activities.find(function(activity){return activity.kind==="assessment"});
      var indicators=[];
      if(block)indicators.push(block.kind);
      if(assessment)indicators.push(assessment.kind);
      if(!indicators.length){
        var prioritizedKind=["break","training","school-event","term"];
        for(var kindIndex=0;kindIndex<prioritizedKind.length;kindIndex++){
          if(activities.some(function(activity){return activity.kind===prioritizedKind[kindIndex]})){
            indicators.push(prioritizedKind[kindIndex]);
            break;
          }
        }
      }
      return indicators;
    }
    function calendarSchoolActivityIndicatorLabel(kind){
      return {
        "opening-block":"Opening block",
        "instructional-block":"Instructional block",
        "end-of-term-block":"End-of-term block",
        examination:"Examination",
        assessment:"Assessment",
        break:"School break",
        training:"Training",
        "school-event":"DepEd activity",
        term:"Term milestone"
      }[kind]||"DepEd activity";
    }
    function renderTeacherCalendarSchoolYear(schedule){
      $("teacherCalendarSchoolYearSummary").textContent=
        calendarSchoolYearDateRange(schedule.firstDay,schedule.lastDay,true)
        +" · "+schedule.totalClassDays+" class days.";
      var termList=$("teacherCalendarTermList");
      termList.replaceChildren();
      schedule.terms.forEach(function(term){
        var termItem=document.createElement("li");
        termItem.className="teacher-calendar-term";
        var heading=document.createElement("h4");
        heading.textContent=term.name;
        var termDates=document.createElement("span");
        termDates.className="teacher-calendar-term-date";
        termDates.textContent=calendarSchoolYearDateRange(term.startDate,term.endDate);
        var days=document.createElement("span");
        days.className="teacher-calendar-term-days";
        days.textContent=term.classDays+" class days";
        var blocks=document.createElement("ul");
        blocks.className="teacher-calendar-term-blocks";
        [
          ["Opening",term.openingBlock],
          ["Instructional",term.instructionalBlock],
          ["End-of-term",term.endOfTermBlock]
        ].forEach(function(block){
          if(!block[1])return;
          var blockItem=document.createElement("li");
          blockItem.textContent=block[0]+": "+calendarSchoolYearDateRange(block[1].startDate,block[1].endDate)
            +" ("+block[1].classDays+" class days)";
          blocks.appendChild(blockItem);
        });
        termItem.append(heading,termDates,days,blocks);
        termList.appendChild(termItem);
      });
    }
    function calendarSetStatus(message,isError){
      var status=$("teacherCalendarStatus");
      status.textContent=message;
      status.classList.toggle("error",Boolean(isError));
    }
    function updateTeacherCalendarClock(){
      var now=new Date();
      $("teacherCalendarClockTime").textContent=calendarDateLabel(now,{hour:"numeric",minute:"2-digit",second:"2-digit"});
      $("teacherCalendarClockDate").textContent=calendarDateLabel(now,{weekday:"long",year:"numeric",month:"long",day:"numeric"});
    }
    function calendarMunicipalityMatches(district){
      var normalized=String(district||"").trim().toLocaleLowerCase();
      if(!normalized)return "";
      var selector=$("teacherCalendarMunicipality");
      for(var index=0;index<selector.options.length;index++){
        var option=selector.options[index];
        if(option.value&&option.textContent.trim().toLocaleLowerCase()===normalized)return option.value;
      }
      return "";
    }
    function loadTeacherCalendar(){
      calendarState.loading=true;
      $("teacherCalendarGridViewLabel").textContent=calendarState.view==="week"?"Week":"Month";
      var requestSequence=++calendarState.loadSequence;
      var startUpMessages=[];
      var initializeProfile=calendarState.initialized?Promise.resolve():api("/api/teacher/profile").then(function(profile){
        calendarState.profileDistrict=profile.district||"";
        var matchedMunicipality=calendarMunicipalityMatches(calendarState.profileDistrict);
        if(matchedMunicipality)$("teacherCalendarMunicipality").value=matchedMunicipality;
      }).catch(function(error){
        startUpMessages.push("Teacher profile could not be loaded; choose a municipality manually. "+error.message);
      }).finally(function(){calendarState.initialized=true});
      if(!calendarClockTimer){
        updateTeacherCalendarClock();
        calendarClockTimer=window.setInterval(updateTeacherCalendarClock,1000);
      }
      $("teacherCalendarPeriod").textContent="Loading calendar…";
      Promise.resolve(initializeProfile).then(async function(){
        var range=calendarVisibleRange();
        $("teacherCalendarPeriod").textContent=calendarPeriodLabel(range);
        var errors=startUpMessages.slice();
        var holidayBundle=null;
        calendarState.tasks=[];
        if(calendarState.loadedHolidayYear!==calendarState.currentDate.getFullYear()){
          calendarState.holidays=[];
          calendarState.loadedHolidayYear=null;
        }
        var results=await Promise.allSettled([
          api("/api/teacher-calendar/events?from="+encodeURIComponent(range.from)+"&to="+encodeURIComponent(range.to)),
          api("/api/teacher-calendar/holidays?year="+calendarState.currentDate.getFullYear()),
          loadTeacherSchoolCalendar()
        ]);
        if(requestSequence!==calendarState.loadSequence)return;
        if(results[0].status==="fulfilled")calendarState.tasks=results[0].value;
        else errors.push("Tasks could not be loaded. "+results[0].reason.message);
        if(results[1].status==="fulfilled"){
          holidayBundle=results[1].value;
          calendarState.holidays=holidayBundle.holidays;
          calendarState.loadedHolidayYear=holidayBundle.year;
          miniCalendarHolidayCache.set(holidayBundle.year,holidayBundle.holidays);
          if(miniCalendarDate.getFullYear()===holidayBundle.year){
            miniCalendarHolidays=holidayBundle.holidays;
            miniCalendarHolidayYear=holidayBundle.year;
            renderTopbarCalendarHolidays(holidayBundle.sync.national.warning
              ||"Official: "+holidayBundle.sync.national.sourceName+". Local: "+holidayBundle.sync.local.sourceName+".");
          }
          if(holidayBundle.sync.national.warning)errors.push(holidayBundle.sync.national.warning);
        }else{
          calendarState.holidays=[];
          calendarState.loadedHolidayYear=null;
          errors.push("Holidays could not be loaded. "+results[1].reason.message);
        }
        if(results[2].status==="rejected"){
          $("teacherCalendarSchoolYearSummary").textContent="DepEd school-calendar dates could not be loaded.";
          errors.push("DepEd school-calendar dates could not be loaded. "+results[2].reason.message);
        }
        renderTeacherCalendar(range);
        var statusMessage=errors.join(" ");
        if(!statusMessage&&holidayBundle){
          statusMessage="National holidays: "+holidayBundle.sync.national.sourceName+
            ". Local observances: "+holidayBundle.sync.local.sourceName+".";
        }
        calendarSetStatus(statusMessage,errors.length>0);
      }).catch(function(error){
        if(requestSequence===calendarState.loadSequence){
          calendarSetStatus("Calendar could not be loaded. "+error.message,true);
        }
      }).finally(function(){
        if(requestSequence===calendarState.loadSequence)calendarState.loading=false;
      });
    }
    function renderTeacherCalendar(range){
      var selectedMunicipality=$("teacherCalendarMunicipality").value;
      var visibleHolidays=calendarState.holidays.filter(function(holiday){
        return !holiday.municipality||!selectedMunicipality||holiday.municipality===selectedMunicipality;
      });
      var holidaysByDate=new Map();
      var tasksByDate=new Map();
      var schoolActivitiesByDate=new Map();
      visibleHolidays.forEach(function(holiday){
        if(!holidaysByDate.has(holiday.date))holidaysByDate.set(holiday.date,[]);
        holidaysByDate.get(holiday.date).push(holiday);
      });
      calendarState.tasks.forEach(function(task){
        if(!tasksByDate.has(task.date))tasksByDate.set(task.date,[]);
        tasksByDate.get(task.date).push(task);
      });
      if(calendarState.schoolCalendar){
        calendarState.schoolCalendar.activities.forEach(function(activity){
          calendarSchoolActivityDates(activity).forEach(function(activityDate){
            if(!schoolActivitiesByDate.has(activityDate))schoolActivitiesByDate.set(activityDate,[]);
            schoolActivitiesByDate.get(activityDate).push({
              activity:activity,
              showLabel:Array.isArray(activity.dates)||activityDate===activity.date
            });
          });
        });
      }
      var days=calendarState.view==="month"?42:7;
      $("teacherCalendarPeriod").textContent=calendarPeriodLabel(range);
      calendarGrid.replaceChildren();
      for(var dayOffset=0;dayOffset<days;dayOffset++){
        var date=new Date(range.start);
        date.setDate(date.getDate()+dayOffset);
        var isoDate=calendarDateIso(date);
        var cell=document.createElement("div");
        cell.className="teacher-calendar-day";
        cell.setAttribute("role","gridcell");
        cell.setAttribute("aria-label",calendarDateLabel(date,{weekday:"long",month:"long",day:"numeric",year:"numeric"}));
        if(calendarState.view==="month"&&date.getMonth()!==calendarState.currentDate.getMonth())cell.classList.add("is-outside-month");
        if(isoDate===calendarDateIso(new Date()))cell.classList.add("is-today");
        var holidayItems=holidaysByDate.get(isoDate)||[];
        var isNonWorkingHoliday=holidayItems.some(function(holiday){return holiday.isNonWorking});
        if(isNonWorkingHoliday)cell.classList.add("is-holiday");
        var schoolActivities=schoolActivitiesByDate.get(isoDate)||[];
        var schoolActivityIndicators=calendarSchoolActivityIndicators(schoolActivities);
        if(schoolActivities.length){
          cell.classList.add("has-deped-activity");
          schoolActivities.forEach(function(entry){
            cell.classList.add("has-deped-"+entry.activity.kind);
          });
          if(!isNonWorkingHoliday&&schoolActivityIndicators.length){
            cell.classList.add("has-deped-highlight-"+schoolActivityIndicators[0]);
          }
          var schoolActivityLabels=schoolActivities.map(function(entry){
            var activity=entry.activity;
            var activityDates=activity.endDate
              ?calendarSchoolYearDateRange(activity.date,activity.endDate)
              :Array.isArray(activity.dates)
                ?activity.dates.map(function(activityDate){
                  return calendarDateLabel(calendarDateFromIso(activityDate),{month:"short",day:"numeric",year:"numeric"});
                }).join(", ")
                :calendarDateLabel(calendarDateFromIso(activity.date),{month:"short",day:"numeric",year:"numeric"});
            return activity.title+" ("+activityDates+")";
          });
          var activitySummary="DepEd schedule: "+schoolActivityLabels.join("; ");
          if(schoolActivityIndicators.length){
            activitySummary+="; Indicators: "+schoolActivityIndicators.map(calendarSchoolActivityIndicatorLabel).join(", ");
          }
          cell.title=activitySummary;
          cell.setAttribute("aria-label",cell.getAttribute("aria-label")+"; "+activitySummary);
        }

        var dateButton=document.createElement("button");
        dateButton.className="teacher-calendar-date";
        dateButton.type="button";
        dateButton.setAttribute("aria-label","Add task on "+cell.getAttribute("aria-label"));
        dateButton.addEventListener("click",function(taskDate){return function(){openTeacherCalendarTask(taskDate)}}(isoDate));
        var dateNumber=document.createElement("span");
        dateNumber.textContent=String(date.getDate());
        dateButton.appendChild(dateNumber);
        if(isoDate===calendarDateIso(new Date())){
          var todayLabel=document.createElement("span");
          todayLabel.className="teacher-calendar-today-label";
          todayLabel.textContent="Today";
          dateButton.appendChild(todayLabel);
        }
        cell.appendChild(dateButton);

        if(schoolActivityIndicators.length){
          var indicatorList=document.createElement("div");
          indicatorList.className="teacher-calendar-day-indicators";
          schoolActivityIndicators.forEach(function(kind){
            var indicator=document.createElement("span");
            indicator.className="teacher-calendar-day-indicator teacher-calendar-day-indicator--"+kind;
            indicator.textContent=calendarSchoolActivityIndicatorLabel(kind);
            indicatorList.appendChild(indicator);
          });
          cell.appendChild(indicatorList);
        }

        var itemList=document.createElement("div");
        itemList.className="teacher-calendar-items";
        holidayItems.forEach(function(holiday){
          var holidayItem=document.createElement("div");
          holidayItem.className="teacher-calendar-item teacher-calendar-item--"+(holiday.kind==="local"?"local":"official");
          holidayItem.textContent=(holiday.kind==="local"?"Local · ":"Official · ")+holiday.title;
          holidayItem.title=holiday.title+" — "+holiday.holidayType+"; "+holiday.sourceName;
          holidayItem.setAttribute("aria-label",holiday.title+", "+holiday.kind+" holiday, "+holiday.holidayType);
          itemList.appendChild(holidayItem);
        });
        schoolActivities.forEach(function(entry){
          if(!entry.showLabel)return;
          var activity=entry.activity;
          var activityItem=document.createElement("div");
          activityItem.className="teacher-calendar-item teacher-calendar-item--deped teacher-calendar-item--deped-"+activity.kind;
          activityItem.textContent="DepEd · "+activity.title;
          activityItem.title=activity.title+(activity.endDate
            ?" — "+calendarSchoolYearDateRange(activity.date,activity.endDate)
            :Array.isArray(activity.dates)
              ?" — "+activity.dates.map(function(activityDate){
                return calendarDateLabel(calendarDateFromIso(activityDate),{month:"long",day:"numeric",year:"numeric"});
              }).join(", ")
              :" — "+calendarDateLabel(calendarDateFromIso(activity.date),{month:"long",day:"numeric",year:"numeric"}));
          activityItem.setAttribute("aria-label",activity.title+", DepEd school-calendar activity");
          itemList.appendChild(activityItem);
        });
        (tasksByDate.get(isoDate)||[]).forEach(function(task){
          var taskItem=document.createElement("button");
          taskItem.className="teacher-calendar-item"+(task.isDone?" is-done":"");
          taskItem.type="button";
          taskItem.title=task.title+(task.notes?" — "+task.notes:"");
          taskItem.setAttribute("aria-label",(task.isDone?"Completed: ":"")+task.title);
          var taskText=document.createElement("span");
          taskText.textContent=task.title;
          taskItem.appendChild(taskText);
          if(task.startTime){
            var taskTime=document.createElement("time");
            taskTime.textContent=task.startTime+(task.endTime?"–"+task.endTime:"");
            taskItem.appendChild(taskTime);
          }
          taskItem.addEventListener("click",function(selectedTask){return function(){openTeacherCalendarTask(selectedTask.date,selectedTask)}}(task));
          itemList.appendChild(taskItem);
        });
        cell.appendChild(itemList);

        var addButton=document.createElement("button");
        addButton.className="teacher-calendar-day-add";
        addButton.type="button";
        addButton.textContent="+ Add";
        addButton.setAttribute("aria-label","Add task on "+cell.getAttribute("aria-label"));
        addButton.addEventListener("click",function(taskDate){return function(){openTeacherCalendarTask(taskDate)}}(isoDate));
        cell.appendChild(addButton);
        calendarGrid.appendChild(cell);
      }
    }
    function openTeacherCalendarTask(date,task){
      calendarState.activeTaskId=task?task.id:null;
      calendarState.selectedDate=date;
      $("teacherCalendarDialogTitle").textContent=task?"Edit calendar task":"Add calendar task";
      $("teacherCalendarTaskTitle").value=task?task.title:"";
      $("teacherCalendarTaskDate").value=task?task.date:date;
      $("teacherCalendarTaskStart").value=task?task.startTime:"";
      $("teacherCalendarTaskEnd").value=task?task.endTime:"";
      $("teacherCalendarTaskNotes").value=task?task.notes:"";
      $("teacherCalendarDeleteTask").hidden=!task;
      $("teacherCalendarDialogError").hidden=true;
      $("teacherCalendarDialogError").textContent="";
      calendarDialog.showModal();
      $("teacherCalendarTaskTitle").focus();
    }
    function openTopbarDeadlineTaskForRescheduling(task){
      showDashboardPage("tools");
      if($("toolsPage").hidden)return;
      calendarState.currentDate=calendarDateFromIso(task.date);
      calendarState.view="month";
      $("teacherCalendarMonthView").setAttribute("aria-pressed","true");
      $("teacherCalendarWeekView").setAttribute("aria-pressed","false");
      closeTopbarMiniCalendar(false);
      selectToolPanel("calendarPanel",true);
      openTeacherCalendarTask(task.date,task);
    }
    function calendarTaskPayload(){
      return {
        title:$("teacherCalendarTaskTitle").value.trim(),
        date:$("teacherCalendarTaskDate").value,
        startTime:$("teacherCalendarTaskStart").value,
        endTime:$("teacherCalendarTaskEnd").value,
        notes:$("teacherCalendarTaskNotes").value.trim()
      };
    }
    async function reloadTeacherCalendarAfterTaskChange(){
      calendarState.loading=false;
      loadTeacherCalendar();
      refreshTopbarDeadlineTasks();
      invalidateTopbarMiniCalendarTasks();
    }
    $("teacherCalendarPrevious").onclick=function(){
      if(calendarState.view==="week")calendarState.currentDate.setDate(calendarState.currentDate.getDate()-7);
      else calendarState.currentDate=new Date(calendarState.currentDate.getFullYear(),calendarState.currentDate.getMonth()-1,1,12);
      loadTeacherCalendar();
    };
    $("teacherCalendarNext").onclick=function(){
      if(calendarState.view==="week")calendarState.currentDate.setDate(calendarState.currentDate.getDate()+7);
      else calendarState.currentDate=new Date(calendarState.currentDate.getFullYear(),calendarState.currentDate.getMonth()+1,1,12);
      loadTeacherCalendar();
    };
    $("teacherCalendarToday").onclick=function(){
      calendarState.currentDate=new Date();
      loadTeacherCalendar();
    };
    $("teacherCalendarMonthView").onclick=function(){
      calendarState.view="month";
      $("teacherCalendarMonthView").setAttribute("aria-pressed","true");
      $("teacherCalendarWeekView").setAttribute("aria-pressed","false");
      loadTeacherCalendar();
    };
    $("teacherCalendarWeekView").onclick=function(){
      calendarState.view="week";
      $("teacherCalendarMonthView").setAttribute("aria-pressed","false");
      $("teacherCalendarWeekView").setAttribute("aria-pressed","true");
      loadTeacherCalendar();
    };
    $("teacherCalendarAddTask").onclick=function(){openTeacherCalendarTask(calendarDateIso(calendarState.currentDate))};
    $("teacherCalendarMunicipality").onchange=function(){
      renderTeacherCalendar(calendarVisibleRange());
      renderTopbarCalendarHolidays();
    };
    $("teacherCalendarCancelTask").onclick=function(){calendarDialog.close()};
    $("teacherCalendarEventForm").onsubmit=async function(event){
      event.preventDefault();
      var saveButton=$("teacherCalendarSaveTask");
      var payload=calendarTaskPayload();
      saveButton.disabled=true;
      try{
        await api(calendarState.activeTaskId
          ?"/api/teacher-calendar/events/"+encodeURIComponent(calendarState.activeTaskId)
          :"/api/teacher-calendar/events",{
          method:calendarState.activeTaskId?"PUT":"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify(payload)
        });
        calendarDialog.close();
        await reloadTeacherCalendarAfterTaskChange();
      }catch(error){
        $("teacherCalendarDialogError").textContent=error.message;
        $("teacherCalendarDialogError").hidden=false;
      }finally{saveButton.disabled=false}
    };
    $("teacherCalendarDeleteTask").onclick=async function(){
      if(!calendarState.activeTaskId||!window.confirm("Delete this calendar task?"))return;
      var deleteButton=$("teacherCalendarDeleteTask");
      deleteButton.disabled=true;
      try{
        await api("/api/teacher-calendar/events/"+encodeURIComponent(calendarState.activeTaskId),{method:"DELETE"});
        calendarDialog.close();
        await reloadTeacherCalendarAfterTaskChange();
      }catch(error){
        $("teacherCalendarDialogError").textContent=error.message;
        $("teacherCalendarDialogError").hidden=false;
      }finally{deleteButton.disabled=false}
    };
    $("navTools").addEventListener("click",function(){
      if($("toolsSelector").value==="calendarPanel")loadTeacherCalendar();
    });

    function selectToolPanel(panelId,focus){
      panelIds.forEach(function(id){
        $(id).hidden=id!==panelId;
      });
      $("toolsSelector").value=panelId;
      $("toolsSelector").setAttribute("aria-controls",panelId);
      if(panelId==="calendarPanel")loadTeacherCalendar();
      if(panelId==="lessonPlanPanel")initializeLessonPlan();
      if(focus)$("toolsSelector").focus();
    }
    $("toolsSelector").addEventListener("change",function(){
      selectToolPanel(this.value,false);
    });
    miniCalendarToggle.onclick=function(){
      if(!miniCalendarPopover.hidden){
        closeTopbarMiniCalendar(true);
        return;
      }
      renderTopbarMiniCalendar();
      miniCalendarPopover.hidden=false;
      positionTopbarMiniCalendar();
      miniCalendarToggle.setAttribute("aria-expanded","true");
      syncTopbarCalendarHolidays(miniCalendarDate.getFullYear());
      refreshTopbarDeadlineTasks();
      syncTopbarMiniCalendarTasks(true);
      var selectedDay=miniCalendarGrid.querySelector(".is-selected");
      if(selectedDay)selectedDay.focus();
    };
    var miniCalendarDragHandle=$("topbarMiniCalendarMonth");
    miniCalendarResizeHandle.addEventListener("pointerdown",function(event){
      if(event.button!==0)return;
      positionTopbarMiniCalendar();
      var bounds=miniCalendarPopover.getBoundingClientRect();
      miniCalendarResize={pointerId:event.pointerId,startX:event.clientX,startWidth:bounds.width,right:bounds.right};
      event.preventDefault();
    });
    miniCalendarResizeHandle.addEventListener("keydown",function(event){
      if(miniCalendarPopover.hidden||(event.key!=="ArrowLeft"&&event.key!=="ArrowRight"))return;
      positionTopbarMiniCalendar();
      var bounds=miniCalendarPopover.getBoundingClientRect();
      var step=event.shiftKey?80:16;
      var direction=event.key==="ArrowLeft"?1:-1;
      setTopbarMiniCalendarWidth(bounds.width+direction*step,bounds.right);
      event.preventDefault();
    });
    miniCalendarDragHandle.addEventListener("pointerdown",function(event){
      if(event.button!==0)return;
      positionTopbarMiniCalendar();
      var bounds=miniCalendarPopover.getBoundingClientRect();
      miniCalendarDrag={pointerId:event.pointerId,offsetX:event.clientX-bounds.left,offsetY:event.clientY-bounds.top};
      event.preventDefault();
    });
    document.addEventListener("pointermove",function(event){
      if(miniCalendarResize&&miniCalendarResize.pointerId===event.pointerId){
        setTopbarMiniCalendarWidth(miniCalendarResize.startWidth+miniCalendarResize.startX-event.clientX,miniCalendarResize.right);
        return;
      }
      if(!miniCalendarDrag||miniCalendarDrag.pointerId!==event.pointerId)return;
      setTopbarMiniCalendarPosition(event.clientX-miniCalendarDrag.offsetX,event.clientY-miniCalendarDrag.offsetY);
      keepTopbarMiniCalendarInViewport();
    });
    function stopTopbarMiniCalendarDrag(event){
      if(miniCalendarDrag&&miniCalendarDrag.pointerId===event.pointerId)miniCalendarDrag=null;
      if(miniCalendarResize&&miniCalendarResize.pointerId===event.pointerId)miniCalendarResize=null;
    }
    document.addEventListener("pointerup",stopTopbarMiniCalendarDrag);
    document.addEventListener("pointercancel",stopTopbarMiniCalendarDrag);
    window.addEventListener("resize",function(){
      if(!miniCalendarPopover.hidden&&miniCalendarHasCustomPosition){
        keepTopbarMiniCalendarInViewport();
        syncTopbarMiniCalendarResizeHandle(miniCalendarPopover.getBoundingClientRect().width);
      }
    });
    $("topbarMiniCalendarPrevious").onclick=function(){
      miniCalendarDate=new Date(miniCalendarDate.getFullYear(),miniCalendarDate.getMonth()-1,1,12);
      renderTopbarMiniCalendar();
      syncTopbarCalendarHolidays(miniCalendarDate.getFullYear());
      syncTopbarMiniCalendarTasks();
    };
    $("topbarMiniCalendarNext").onclick=function(){
      miniCalendarDate=new Date(miniCalendarDate.getFullYear(),miniCalendarDate.getMonth()+1,1,12);
      renderTopbarMiniCalendar();
      syncTopbarCalendarHolidays(miniCalendarDate.getFullYear());
      syncTopbarMiniCalendarTasks();
    };
    $("topbarMiniCalendarClose").onclick=function(){closeTopbarMiniCalendar(true)};
    $("topbarMiniCalendarOpen").onclick=function(){
      showDashboardPage("tools");
      if($("toolsPage").hidden)return;
      calendarState.currentDate=calendarDateFromIso(miniCalendarSelectedDate);
      calendarState.view="month";
      $("teacherCalendarMonthView").setAttribute("aria-pressed","true");
      $("teacherCalendarWeekView").setAttribute("aria-pressed","false");
      closeTopbarMiniCalendar(false);
      selectToolPanel("calendarPanel",true);
    };
    document.addEventListener("pointerdown",function(event){
      if(!miniCalendarPopover.hidden&&!miniCalendarPopover.contains(event.target)&&!miniCalendarToggle.contains(event.target)){
        closeTopbarMiniCalendar(false);
      }
    });
    document.addEventListener("keydown",function(event){
      if(event.key==="Escape"&&!miniCalendarPopover.hidden){
        event.preventDefault();
        closeTopbarMiniCalendar(true);
      }
    });

    var bannerWidth=$("tarpaulinWidth"),bannerHeight=$("tarpaulinHeight");
    var bannerUnit=$("tarpaulinUnit"),bannerPaperSize=$("tarpaulinPaperSize"),bannerOrientation=$("tarpaulinOrientation"),bannerColor=$("tarpaulinColor");
    var bannerSheetLayout=$("tarpaulinSheetLayout"),customSheetGrid=$("tarpaulinCustomSheetGrid");
    var bannerSheetsAcross=$("tarpaulinSheetsAcross"),bannerSheetsDown=$("tarpaulinSheetsDown");
    var bannerImageFit=$("tarpaulinImageFit"),preview=$("tarpaulinPreview");
    var previewImage=$("tarpaulinPreviewImage"),bannerImageFile=null,bannerImageUrl="";
    var tarpaulinEditor=document.querySelector(".tarpaulin-editor");
    var tarpaulinControlsCard=document.querySelector(".tarpaulin-controls-card");
    var tarpaulinControlsToggle=$("tarpaulinControlsToggle"),tarpaulinControlsCollapsed=false;
    var tarpaulinResizeHandle=$("tarpaulinResizeHandle");
    var tarpaulinResizeStartX=0,tarpaulinResizeStartWidth=0,tarpaulinIsResizing=false;
    var tarpaulinZoom=1;
    var tarpaulinNotice=$("tarpaulinNotice"),previousUnit=bannerUnit.value;
    var tarpaulinPaperSizes={a4:{portrait:"A4 portrait",landscape:"A4 landscape"},legal:{portrait:"8.5in 13in",landscape:"13in 8.5in"}};
    var tarpaulinPaperDimensions={a4:{width:210,height:297},legal:{width:215.9,height:330.2}};
    var tarpaulinPrintMarginsMm={top:25.4,right:12.7,bottom:12.7,left:25.4},tarpaulinOverlapMm=0;
    var tarpaulinSheetGridError="";
    var tarpaulinPdfLibraryPromise=null;
    var tarpaulinPrintPageStyle=document.createElement("style");
    function tarpaulinResizeLimits(){
      var editorWidth=tarpaulinEditor.getBoundingClientRect().width;
      var handleWidth=tarpaulinResizeHandle.getBoundingClientRect().width||18;
      return {
        editorWidth:editorWidth,
        min:280,
        max:Math.max(280,editorWidth-handleWidth-180)
      };
    }
    function setTarpaulinControlsWidth(width){
      var limits=tarpaulinResizeLimits();
      if(!limits.editorWidth)return;
      var nextWidth=Math.max(limits.min,Math.min(limits.max,width));
      tarpaulinEditor.style.setProperty(
        "--tarpaulin-controls-width",(nextWidth/limits.editorWidth*100)+"%"
      );
      tarpaulinResizeHandle.setAttribute("aria-valuemin",String(limits.min));
      tarpaulinResizeHandle.setAttribute("aria-valuemax",String(Math.round(limits.max)));
      tarpaulinResizeHandle.setAttribute("aria-valuenow",String(Math.round(nextWidth)));
      tarpaulinResizeHandle.setAttribute("aria-valuetext",Math.round(nextWidth)+" pixels for controls");
    }
    function syncTarpaulinResizeHandle(){
      var limits=tarpaulinResizeLimits();
      if(!limits.editorWidth)return;
      var currentWidth=tarpaulinControlsCard.getBoundingClientRect().width;
      if(tarpaulinEditor.style.getPropertyValue("--tarpaulin-controls-width")&&currentWidth>limits.max+1){
        setTarpaulinControlsWidth(limits.max);
        return;
      }
      var value=Math.max(limits.min,Math.min(limits.max,currentWidth));
      tarpaulinResizeHandle.setAttribute("aria-valuemin",String(limits.min));
      tarpaulinResizeHandle.setAttribute("aria-valuemax",String(Math.round(limits.max)));
      tarpaulinResizeHandle.setAttribute("aria-valuenow",String(Math.round(value)));
      tarpaulinResizeHandle.setAttribute("aria-valuetext",Math.round(value)+" pixels for controls");
    }
    function setTarpaulinControlsCollapsed(collapsed){
      tarpaulinControlsCollapsed=collapsed;
      tarpaulinEditor.classList.toggle("controls-collapsed",collapsed);
      tarpaulinControlsToggle.textContent=collapsed?"Show controls":"Hide controls";
      tarpaulinControlsToggle.setAttribute("aria-expanded",String(!collapsed));
      if(!collapsed)syncTarpaulinResizeHandle();
    }
    tarpaulinControlsToggle.addEventListener("click",function(){
      setTarpaulinControlsCollapsed(!tarpaulinControlsCollapsed);
    });
    function stopTarpaulinResize(){
      tarpaulinIsResizing=false;
      document.body.classList.remove("tarpaulin-resizing");
    }
    tarpaulinResizeHandle.addEventListener("pointerdown",function(event){
      if(event.button!==0)return;
      event.preventDefault();
      syncTarpaulinResizeHandle();
      tarpaulinIsResizing=true;
      tarpaulinResizeStartX=event.clientX;
      tarpaulinResizeStartWidth=tarpaulinControlsCard.getBoundingClientRect().width;
      tarpaulinResizeHandle.setPointerCapture(event.pointerId);
      document.body.classList.add("tarpaulin-resizing");
    });
    tarpaulinResizeHandle.addEventListener("pointermove",function(event){
      if(!tarpaulinIsResizing)return;
      setTarpaulinControlsWidth(tarpaulinResizeStartWidth+event.clientX-tarpaulinResizeStartX);
    });
    tarpaulinResizeHandle.addEventListener("pointerup",stopTarpaulinResize);
    tarpaulinResizeHandle.addEventListener("pointercancel",stopTarpaulinResize);
    tarpaulinResizeHandle.addEventListener("lostpointercapture",stopTarpaulinResize);
    tarpaulinResizeHandle.addEventListener("focus",syncTarpaulinResizeHandle);
    tarpaulinResizeHandle.addEventListener("keydown",function(event){
      var limits=tarpaulinResizeLimits();
      var currentWidth=tarpaulinControlsCard.getBoundingClientRect().width;
      var nextWidth=currentWidth;
      if(event.key==="ArrowLeft")nextWidth-=24;
      else if(event.key==="ArrowRight")nextWidth+=24;
      else if(event.key==="Home")nextWidth=limits.min;
      else if(event.key==="End")nextWidth=limits.max;
      else return;
      event.preventDefault();
      setTarpaulinControlsWidth(nextWidth);
    });
    if(typeof ResizeObserver==="function"){
      var tarpaulinResizeObserver=new ResizeObserver(syncTarpaulinResizeHandle);
      tarpaulinResizeObserver.observe(tarpaulinEditor);
    }else{
      window.addEventListener("resize",syncTarpaulinResizeHandle);
    }
    function showTarpaulinNotice(message,isError){
      tarpaulinNotice.textContent=message;
      tarpaulinNotice.hidden=!message;
      tarpaulinNotice.classList.toggle("error",!!isError);
    }
    function updateDimensionUnits(){
      var isInches=bannerUnit.value==="in";
      [bannerWidth,bannerHeight].forEach(function(input){
        input.min=isInches?"0.394":"1";
        input.max=isInches?"393.8":"1000";
        input.step="any";
      });
      $("tarpaulinWidthUnit").textContent="("+bannerUnit.value+")";
      $("tarpaulinHeightUnit").textContent="("+bannerUnit.value+")";
    }
    function bannerDimensions(){
      var width=Number(bannerWidth.value),height=Number(bannerHeight.value);
      var scale=bannerUnit.value==="in"?2.54:1;
      var widthCm=width*scale,heightCm=height*scale;
      return Number.isFinite(widthCm)&&Number.isFinite(heightCm)&&widthCm>=0.999&&heightCm>=0.999&&widthCm<=1000.001&&heightCm<=1000.001
        ?{width:width,height:height,widthCm:widthCm,heightCm:heightCm,unit:bannerUnit.value}
        :null;
    }
    function syncBannerSizeToImage(image){
      if(!image.naturalWidth||!image.naturalHeight)return false;
      var unitScale=bannerUnit.value==="in"?2.54:1;
      var widthCm=Number(bannerWidth.value)*unitScale;
      if(!Number.isFinite(widthCm)||widthCm<1||widthCm>1000)widthCm=300;
      var heightCm=widthCm*image.naturalHeight/image.naturalWidth;
      var minScale=Math.max(1/widthCm,1/heightCm);
      var maxScale=Math.min(1000/widthCm,1000/heightCm);
      if(minScale>maxScale)return false;
      var fitScale=Math.max(minScale,Math.min(1,maxScale));
      var outputScale=bannerUnit.value==="in"?1/2.54:1;
      var precision=bannerUnit.value==="in"?3:2;
      bannerWidth.value=(widthCm*fitScale*outputScale).toFixed(precision);
      bannerHeight.value=(heightCm*fitScale*outputScale).toFixed(precision);
      return true;
    }
    function getTarpaulinPrintLayout(dimensions,paperSize,orientation,requestedGrid){
      var paper=tarpaulinPaperDimensions[paperSize];
      var margins=tarpaulinPrintMarginsMm;
      var paperWidthMm=orientation==="landscape"?paper.height:paper.width;
      var paperHeightMm=orientation==="landscape"?paper.width:paper.height;
      var tileWidthMm=paperWidthMm-margins.left-margins.right;
      var tileHeightMm=paperHeightMm-margins.top-margins.bottom;
      var strideWidthMm=tileWidthMm-tarpaulinOverlapMm;
      var strideHeightMm=tileHeightMm-tarpaulinOverlapMm;
      var bannerWidthMm=dimensions.widthCm*10;
      var bannerHeightMm=dimensions.heightCm*10;
      var columns=requestedGrid?requestedGrid.columns:Math.max(1,Math.ceil((bannerWidthMm-tarpaulinOverlapMm)/strideWidthMm));
      var rows=requestedGrid?requestedGrid.rows:Math.max(1,Math.ceil((bannerHeightMm-tarpaulinOverlapMm)/strideHeightMm));
      return {
        paperWidthMm:paperWidthMm,
        paperHeightMm:paperHeightMm,
        tileWidthMm:tileWidthMm,
        tileHeightMm:tileHeightMm,
        strideWidthMm:strideWidthMm,
        strideHeightMm:strideHeightMm,
        bannerWidthMm:bannerWidthMm,
        bannerHeightMm:bannerHeightMm,
        columns:columns,
        rows:rows,
        total:columns*rows
      };
    }
    function tarpaulinBannerScaleForGrid(dimensions,layout){
      var maxWidthCm=(layout.tileWidthMm+(layout.columns-1)*layout.strideWidthMm)/10;
      var maxHeightCm=(layout.tileHeightMm+(layout.rows-1)*layout.strideHeightMm)/10;
      var minScale=Math.max(1/dimensions.widthCm,1/dimensions.heightCm);
      var fitScale=Math.min(
        maxWidthCm/dimensions.widthCm,
        maxHeightCm/dimensions.heightCm,
        1000/dimensions.widthCm,
        1000/dimensions.heightCm
      );
      return fitScale>=minScale?fitScale:null;
    }
    function tarpaulinBannerSizeForGrid(dimensions,layout,stretch){
      var maxWidthCm=(layout.tileWidthMm+(layout.columns-1)*layout.strideWidthMm)/10;
      var maxHeightCm=(layout.tileHeightMm+(layout.rows-1)*layout.strideHeightMm)/10;
      if(stretch){
        return maxWidthCm>=1&&maxWidthCm<=1000&&maxHeightCm>=1&&maxHeightCm<=1000
          ?{widthCm:maxWidthCm,heightCm:maxHeightCm}
          :null;
      }
      var fitScale=tarpaulinBannerScaleForGrid(dimensions,layout);
      return fitScale===null?null:{
        widthCm:dimensions.widthCm*fitScale,
        heightCm:dimensions.heightCm*fitScale
      };
    }
    function getTarpaulinPdfImagePlacement(imageWidth,imageHeight,bannerWidthMm,bannerHeightMm,fit){
      if(fit==="stretch"){
        return {x:0,y:0,width:bannerWidthMm,height:bannerHeightMm};
      }
      var scale=fit==="cover"
        ?Math.max(bannerWidthMm/imageWidth,bannerHeightMm/imageHeight)
        :Math.min(bannerWidthMm/imageWidth,bannerHeightMm/imageHeight);
      var width=imageWidth*scale,height=imageHeight*scale;
      return {
        x:(bannerWidthMm-width)/2,
        y:(bannerHeightMm-height)/2,
        width:width,
        height:height
      };
    }
    function getTarpaulinPdfVisibleArea(layout,offsetX,offsetY){
      return {
        width:Math.max(0,Math.min(layout.tileWidthMm,layout.bannerWidthMm-offsetX)),
        height:Math.max(0,Math.min(layout.tileHeightMm,layout.bannerHeightMm-offsetY))
      };
    }
    function getTarpaulinRightCutOffsetMm(layout,visibleArea,hasNextColumn){
      if(hasNextColumn)return null;
      var blankWidth=layout.tileWidthMm-visibleArea.width;
      if(blankWidth+1e-9<tarpaulinPrintMarginsMm.right)return null;
      return Math.min(layout.tileWidthMm,visibleArea.width+tarpaulinPrintMarginsMm.right);
    }
    function getTarpaulinBottomCutOffsetMm(layout,visibleArea,hasNextRow){
      if(hasNextRow)return layout.tileHeightMm;
      var blankHeight=layout.tileHeightMm-visibleArea.height;
      if(blankHeight<tarpaulinPrintMarginsMm.bottom)return null;
      return visibleArea.height+tarpaulinPrintMarginsMm.bottom;
    }
    function drawTarpaulinPdfScissor(doc,centerX,centerY,rotation){
      var angle=rotation*Math.PI/180;
      var cosine=Math.cos(angle),sine=Math.sin(angle);
      var markerScale=1.8;
      function point(x,y){
        return [
          centerX+(x*cosine-y*sine)*markerScale,
          centerY+(x*sine+y*cosine)*markerScale
        ];
      }
      doc.saveGraphicsState();
      doc.setDrawColor(136,136,136);
      doc.setLineWidth(0.45);
      [[-1.1,-0.65],[-1.1,0.65]].forEach(function(handle){
        var center=point(handle[0],handle[1]);
        doc.circle(center[0],center[1],0.42*markerScale,"S");
      });
      var pivot=point(0.15,0);
      var upperBladeStart=point(-0.68,-0.35),upperBladeEnd=point(1.25,0.95);
      var lowerBladeStart=point(-0.68,0.35),lowerBladeEnd=point(1.25,-0.95);
      doc.line(upperBladeStart[0],upperBladeStart[1],upperBladeEnd[0],upperBladeEnd[1]);
      doc.line(lowerBladeStart[0],lowerBladeStart[1],lowerBladeEnd[0],lowerBladeEnd[1]);
      doc.circle(pivot[0],pivot[1],0.16*markerScale,"S");
      doc.restoreGraphicsState();
    }
    function drawTarpaulinPdfPageMarks(doc,layout,visibleArea,pageNumber,hasNextColumn,hasNextRow){
      var margins=tarpaulinPrintMarginsMm;
      var left=margins.left,top=margins.top;
      var right=left+visibleArea.width,bottom=top+visibleArea.height;
      var rightCutOffset=getTarpaulinRightCutOffsetMm(layout,visibleArea,hasNextColumn);
      var bottomCutOffset=getTarpaulinBottomCutOffsetMm(layout,visibleArea,hasNextRow);
      doc.setDrawColor(153,153,153);
      doc.setLineWidth(0.25);
      doc.setLineDashPattern([1,1],0);
      doc.line(left,top,right,top);
      if(hasNextRow){
        doc.line(left,bottom,right,bottom);
      }else if(bottomCutOffset!==null){
        doc.setDrawColor(75,85,99);
        doc.setLineWidth(0.45);
        doc.line(left,top+bottomCutOffset,right,top+bottomCutOffset);
      }
      doc.line(left,top,left,bottom);
      if(hasNextColumn)doc.line(right,top,right,bottom);
      if(hasNextColumn||hasNextRow||rightCutOffset!==null){
        doc.setDrawColor(75,85,99);
        doc.setLineWidth(0.45);
        if(hasNextColumn){
          var verticalTrimX=left+layout.tileWidthMm;
          doc.line(verticalTrimX,top,verticalTrimX,top+layout.tileHeightMm);
        }else if(rightCutOffset!==null){
          var verticalTailCutX=left+rightCutOffset;
          doc.line(verticalTailCutX,top,verticalTailCutX,top+layout.tileHeightMm);
        }
        if(hasNextRow){
          var horizontalTrimY=top+layout.tileHeightMm;
          doc.line(left,horizontalTrimY,left+layout.tileWidthMm,horizontalTrimY);
        }
      }
      doc.setLineDashPattern([],0);
      doc.setFont("helvetica","bold");
      doc.setFontSize(14);
      doc.setTextColor(34,34,34);
      doc.text(String(pageNumber),left/2,layout.paperHeightMm/2+1,{align:"center"});
      if(hasNextColumn){
        drawTarpaulinPdfScissor(doc,left+layout.tileWidthMm+margins.right/2,top+3,90);
      }else if(rightCutOffset!==null){
        drawTarpaulinPdfScissor(doc,left+rightCutOffset,top+3,90);
      }
      if(hasNextRow){
        drawTarpaulinPdfScissor(doc,left+3,top+layout.tileHeightMm+margins.bottom/2,0);
      }else if(bottomCutOffset!==null){
        drawTarpaulinPdfScissor(doc,left/2,top+bottomCutOffset,0);
      }
    }
    function requestedTarpaulinSheetGrid(){
      var columns=Number(bannerSheetsAcross.value),rows=Number(bannerSheetsDown.value);
      var valid=Number.isInteger(columns)&&columns>=1&&columns<=53&&Number.isInteger(rows)&&rows>=1&&rows<=53;
      bannerSheetsAcross.setCustomValidity(Number.isInteger(columns)&&columns>=1&&columns<=53?"":"Enter a whole number from 1 to 53.");
      bannerSheetsDown.setCustomValidity(Number.isInteger(rows)&&rows>=1&&rows<=53?"":"Enter a whole number from 1 to 53.");
      return valid?{columns:columns,rows:rows}:null;
    }
    function fitBannerToSheetGrid(){
      var grid=requestedTarpaulinSheetGrid(),dimensions=bannerDimensions();
      if(!grid||!dimensions)return false;
      var layout=getTarpaulinPrintLayout(dimensions,bannerPaperSize.value,bannerOrientation.value,grid);
      var fitSize=tarpaulinBannerSizeForGrid(dimensions,layout,bannerImageFit.value==="stretch");
      if(!fitSize){
        tarpaulinSheetGridError="This paper grid exceeds the supported banner size limits.";
        return false;
      }
      tarpaulinSheetGridError="";
      var outputScale=bannerUnit.value==="in"?1/2.54:1;
      var precision=bannerUnit.value==="in"?3:2;
      bannerWidth.value=(fitSize.widthCm*outputScale).toFixed(precision);
      bannerHeight.value=(fitSize.heightCm*outputScale).toFixed(precision);
      return true;
    }
    function updateTarpaulinSheetPreview(dimensions){
      var guides=$("tarpaulinSheetGuides");
      guides.textContent="";
      guides.style.gridTemplateColumns="";
      if(!dimensions){
        $("tarpaulinSheetCount").textContent="Check sheet count";
        return null;
      }
      var requestedGrid=bannerSheetLayout.value==="custom"?requestedTarpaulinSheetGrid():null;
      if(bannerSheetLayout.value==="custom"&&(!requestedGrid||tarpaulinSheetGridError)){
        $("tarpaulinSheetCount").textContent=tarpaulinSheetGridError||"Enter a valid paper grid";
        return null;
      }
      var layout=getTarpaulinPrintLayout(dimensions,bannerPaperSize.value,bannerOrientation.value,requestedGrid);
      var sheetNumber=0;
      for(var row=0;row<layout.rows;row++){
        for(var column=0;column<layout.columns;column++){
          sheetNumber++;
          var offsetX=column*layout.strideWidthMm;
          var offsetY=row*layout.strideHeightMm;
          var visibleArea=getTarpaulinPdfVisibleArea(layout,offsetX,offsetY);
          var guide=document.createElement("div");
          guide.className="tarpaulin-sheet-guide";
          guide.style.setProperty("--paper-aspect",layout.paperWidthMm+" / "+layout.paperHeightMm);
          var printable=document.createElement("div");
          printable.className="tarpaulin-sheet-printable";
          printable.style.left=(tarpaulinPrintMarginsMm.left/layout.paperWidthMm*100)+"%";
          printable.style.top=(tarpaulinPrintMarginsMm.top/layout.paperHeightMm*100)+"%";
          printable.style.width=(layout.tileWidthMm/layout.paperWidthMm*100)+"%";
          printable.style.height=(layout.tileHeightMm/layout.paperHeightMm*100)+"%";
          var art=document.createElement("div");
          art.className="tarpaulin-sheet-art";
          art.style.left=(-offsetX/layout.tileWidthMm*100)+"%";
          art.style.top=(-offsetY/layout.tileHeightMm*100)+"%";
          art.style.width=(layout.bannerWidthMm/layout.tileWidthMm*100)+"%";
          art.style.height=(layout.bannerHeightMm/layout.tileHeightMm*100)+"%";
          art.style.backgroundColor=bannerColor.value;
          if(bannerImageFile){
            var image=document.createElement("img");
            image.className="tarpaulin-sheet-image";
            image.src=previewImage.src;
            image.alt="";
            image.style.objectFit=bannerImageFit.value==="stretch"?"fill":bannerImageFit.value;
            art.appendChild(image);
          }
          printable.appendChild(art);
          var boundary=document.createElement("span");
          boundary.className="tarpaulin-sheet-printable-boundary";
          printable.appendChild(boundary);
          guide.appendChild(printable);
          var rightCutOffset=getTarpaulinRightCutOffsetMm(
            layout,visibleArea,column<layout.columns-1
          );
          if(rightCutOffset!==null){
            var cutMarker=document.createElement("span");
            cutMarker.className="tarpaulin-sheet-tail-cut";
            cutMarker.setAttribute("aria-hidden","true");
            cutMarker.style.left=((tarpaulinPrintMarginsMm.left+rightCutOffset)/layout.paperWidthMm*100)+"%";
            cutMarker.style.top=(tarpaulinPrintMarginsMm.top/layout.paperHeightMm*100)+"%";
            cutMarker.style.height=(layout.tileHeightMm/layout.paperHeightMm*100)+"%";
            cutMarker.innerHTML='<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2.7"></circle><circle cx="5" cy="18" r="2.7"></circle><path d="M7.5 7.5 20 17M7.5 16.5 20 7"></path><circle cx="10" cy="12" r="1"></circle></svg>';
            guide.appendChild(cutMarker);
          }
          var label=document.createElement("span");
          label.className="tarpaulin-sheet-guide-label";
          label.textContent=String(sheetNumber);
          guide.appendChild(label);
          guides.appendChild(guide);
        }
      }
      $("tarpaulinSheetCount").textContent=layout.total+" "+(layout.total===1?"sheet":"sheets")+" · "+layout.columns+" × "+layout.rows;
      return layout;
    }
    function updateTarpaulinZoom(){
      $("tarpaulinSheetGuides").style.setProperty("--tarpaulin-sheet-min-width",Math.round(190*tarpaulinZoom)+"px");
      preview.style.width="100%";
      $("tarpaulinZoomLevel").textContent=Math.round(tarpaulinZoom*100)+"%";
      $("tarpaulinZoomOut").disabled=tarpaulinZoom<=0.5;
      $("tarpaulinZoomIn").disabled=tarpaulinZoom>=2;
    }
    function updateTarpaulin(){
      var dimensions=bannerDimensions();
      var printLayout=updateTarpaulinSheetPreview(dimensions);
      preview.style.backgroundColor="transparent";
      preview.style.aspectRatio="auto";
      preview.style.setProperty("--tarpaulin-ratio",dimensions?dimensions.widthCm+" / "+dimensions.heightCm:"3 / 1");
      $("tarpaulinPreviewEmpty").hidden=true;
      previewImage.style.objectFit=bannerImageFit.value==="stretch"?"fill":bannerImageFit.value;
      if(dimensions){
        $("tarpaulinDimensions").textContent=dimensions.width+" "+dimensions.unit+" × "+dimensions.height+" "+dimensions.unit;
        $("tarpaulinSheetGridHint").textContent=bannerSheetLayout.value==="custom"
          ?tarpaulinSheetGridError||(
            bannerImageFit.value==="stretch"
              ?"The picture is stretched to fill the selected paper grid. Print margins stay unchanged."
              :"Banner dimensions are scaled to fit the selected sheet grid while preserving proportions."
          )
          :bannerImageFit.value==="stretch"
            ?"Choose a paper grid to stretch the picture across a specific number of pages."
            :"Choose a paper grid to scale the banner to fit that many sheets while preserving its proportions.";
        $("tarpaulinPrintHint").textContent=printLayout
          ?"Dashed boundaries show "+printLayout.total+" "+(printLayout.total===1?"sheet":"sheets")+" of "+bannerPaperSize.options[bannerPaperSize.selectedIndex].text+" "+bannerOrientation.options[bannerOrientation.selectedIndex].text.toLowerCase()+" paper at actual size with 1 in top/left and 0.5 in right/bottom margins. Each page prints a unique banner segment; align the scissor-marked printable edges and tape from the back. SVG keeps the selected "+dimensions.width+" × "+dimensions.height+" "+dimensions.unit+" size."
          :tarpaulinSheetGridError||"Enter valid sheet counts to prepare the tiled print.";
        bannerWidth.setCustomValidity("");
        bannerHeight.setCustomValidity("");
      }else{
        $("tarpaulinDimensions").textContent="Check the banner dimensions";
        $("tarpaulinPrintHint").textContent="Enter a width and height between 1 and 1000 cm (0.39 and 393.70 in).";
        bannerWidth.setCustomValidity("Enter a width between 1 and 1000 cm (0.39 and 393.70 in).");
        bannerHeight.setCustomValidity("Enter a height between 1 and 1000 cm (0.39 and 393.70 in).");
      }
    }
    bannerUnit.addEventListener("change",function(){
      var conversion=previousUnit==="cm"&&bannerUnit.value==="in"?1/2.54:2.54;
      [bannerWidth,bannerHeight].forEach(function(input){
        if(input.value!=="")input.value=(Number(input.value)*conversion).toFixed(bannerUnit.value==="in"?3:2);
      });
      previousUnit=bannerUnit.value;
      updateDimensionUnits();
      if(bannerSheetLayout.value==="custom")fitBannerToSheetGrid();
      updateTarpaulin();
    });
    updateDimensionUnits();
    [bannerWidth,bannerHeight].forEach(function(input){
      function useAutomaticLayout(){
        if(bannerSheetLayout.value==="custom"){
          bannerSheetLayout.value="auto";
          customSheetGrid.hidden=true;
          tarpaulinSheetGridError="";
        }
        updateTarpaulin();
      }
      input.addEventListener("input",useAutomaticLayout);
      input.addEventListener("change",useAutomaticLayout);
    });
    [bannerColor,bannerImageFit].forEach(function(input){
      input.addEventListener("input",updateTarpaulin);
      input.addEventListener("change",function(){
        if(input===bannerImageFit&&input.value==="stretch"&&bannerSheetLayout.value!=="custom"){
          bannerSheetLayout.value="custom";
          bannerSheetLayout.dispatchEvent(new Event("change"));
          return;
        }
        if(input===bannerImageFit&&bannerSheetLayout.value==="custom"){
          tarpaulinSheetGridError="";
          fitBannerToSheetGrid();
        }
        updateTarpaulin();
      });
    });
    [bannerPaperSize,bannerOrientation].forEach(function(input){
      input.addEventListener("change",function(){
        if(bannerSheetLayout.value==="custom"){
          tarpaulinSheetGridError="";
          fitBannerToSheetGrid();
        }
        updateTarpaulin();
      });
    });
    bannerSheetLayout.addEventListener("change",function(){
      customSheetGrid.hidden=bannerSheetLayout.value!=="custom";
      tarpaulinSheetGridError="";
      if(bannerSheetLayout.value==="custom"){
        var dimensions=bannerDimensions();
        if(dimensions){
          var automaticLayout=getTarpaulinPrintLayout(dimensions,bannerPaperSize.value,bannerOrientation.value);
          bannerSheetsAcross.value=String(automaticLayout.columns);
          bannerSheetsDown.value=String(automaticLayout.rows);
          fitBannerToSheetGrid();
        }
      }
      updateTarpaulin();
    });
    [bannerSheetsAcross,bannerSheetsDown].forEach(function(input){
      input.addEventListener("input",function(){
        tarpaulinSheetGridError="";
        if(bannerSheetLayout.value==="custom")fitBannerToSheetGrid();
        updateTarpaulin();
      });
      input.addEventListener("change",function(){
        tarpaulinSheetGridError="";
        if(bannerSheetLayout.value==="custom")fitBannerToSheetGrid();
        updateTarpaulin();
      });
    });
    $("tarpaulinZoomOut").onclick=function(){
      tarpaulinZoom=Math.max(0.5,Math.round((tarpaulinZoom-0.1)*100)/100);
      updateTarpaulinZoom();
    };
    $("tarpaulinZoomIn").onclick=function(){
      tarpaulinZoom=Math.min(2,Math.round((tarpaulinZoom+0.1)*100)/100);
      updateTarpaulinZoom();
    };
    updateTarpaulinZoom();
    updateTarpaulin();
    $("uploadTarpaulinImage").onclick=function(){$("tarpaulinImageInput").click()};
    $("tarpaulinImageInput").onchange=function(){
      var file=this.files&&this.files[0];
      if(!file)return;
      if(!file.type||!file.type.toLowerCase().startsWith("image/")){
        showTarpaulinNotice("Choose a supported image file.",true);
        this.value="";
        return;
      }
      if(bannerImageUrl)URL.revokeObjectURL(bannerImageUrl);
      bannerImageFile=file;
      bannerImageUrl=URL.createObjectURL(file);
      previewImage.hidden=false;
      previewImage.alt="Banner picture: "+file.name;
      $("tarpaulinImageName").textContent=file.name;
      $("removeTarpaulinImage").hidden=false;
      previewImage.onload=function(){
        var stretchingToGrid=bannerImageFit.value==="stretch"&&bannerSheetLayout.value==="custom";
        var matchedAspect=stretchingToGrid||syncBannerSizeToImage(previewImage);
        var fittedGrid=true;
        if(matchedAspect&&bannerSheetLayout.value==="custom"){
          tarpaulinSheetGridError="";
          fittedGrid=fitBannerToSheetGrid();
        }
        showTarpaulinNotice(
          "Picture added ("+previewImage.naturalWidth+" × "+previewImage.naturalHeight+" px). "+(!matchedAspect?"Its aspect ratio is outside the supported banner size range.":!fittedGrid?tarpaulinSheetGridError:bannerImageFit.value==="stretch"&&bannerSheetLayout.value==="custom"?"Picture stretched to fill the selected paper grid.":"Banner size was adjusted to match its aspect ratio."),
          !matchedAspect||!fittedGrid
        );
        updateTarpaulin();
      };
      previewImage.onerror=function(){
        showTarpaulinNotice("This picture could not be opened. Try another image.",true);
      };
      previewImage.src=bannerImageUrl;
      this.value="";
      updateTarpaulin();
    };
    $("removeTarpaulinImage").onclick=function(){
      if(bannerImageUrl)URL.revokeObjectURL(bannerImageUrl);
      bannerImageFile=null;
      bannerImageUrl="";
      previewImage.removeAttribute("src");
      previewImage.hidden=true;
      previewImage.alt="";
      $("tarpaulinImageName").textContent="No picture selected";
      this.hidden=true;
      showTarpaulinNotice("",false);
      updateTarpaulin();
    };
    function readImageAsDataUrl(file){
      return new Promise(function(resolve,reject){
        var reader=new FileReader();
        reader.onload=function(){
          if(typeof reader.result==="string")resolve(reader.result);
          else reject(new Error("The selected picture could not be read."));
        };
        reader.onerror=function(){reject(reader.error||new Error("The selected picture could not be read."))};
        reader.readAsDataURL(file);
      });
    }
    function loadTarpaulinPdfLibrary(){
      if(window.jspdf&&typeof window.jspdf.jsPDF==="function"){
        return Promise.resolve(window.jspdf.jsPDF);
      }
      if(!tarpaulinPdfLibraryPromise){
        tarpaulinPdfLibraryPromise=new Promise(function(resolve,reject){
          var script=document.createElement("script");
          script.src="/assets/jspdf.umd.min.js";
          script.async=true;
          script.onload=function(){
            if(window.jspdf&&typeof window.jspdf.jsPDF==="function"){
              resolve(window.jspdf.jsPDF);
              return;
            }
            tarpaulinPdfLibraryPromise=null;
            reject(new Error("The PDF library could not be initialized."));
          };
          script.onerror=function(){
            tarpaulinPdfLibraryPromise=null;
            reject(new Error("The PDF library could not be loaded."));
          };
          document.head.appendChild(script);
        });
      }
      return tarpaulinPdfLibraryPromise;
    }
    $("downloadTarpaulinPdf").onclick=async function(){
      var button=this;
      var dimensions=bannerDimensions();
      if(!dimensions){bannerWidth.reportValidity();bannerHeight.reportValidity();return}
      var requestedGrid=bannerSheetLayout.value==="custom"?requestedTarpaulinSheetGrid():null;
      if(bannerSheetLayout.value==="custom"&&(!requestedGrid||tarpaulinSheetGridError)){
        if(!requestedGrid){
          bannerSheetsAcross.reportValidity();
          bannerSheetsDown.reportValidity();
        }
        showTarpaulinNotice(tarpaulinSheetGridError||"Enter valid sheet counts to prepare the tiled PDF.",true);
        return;
      }
      button.disabled=true;
      try{
        var JsPDF=await loadTarpaulinPdfLibrary();
        var layout=getTarpaulinPrintLayout(dimensions,bannerPaperSize.value,bannerOrientation.value,requestedGrid);
        var imageDataUrl="";
        var imageWidth=0,imageHeight=0;
        if(bannerImageFile){
          if(!previewImage.complete||!previewImage.naturalWidth||!previewImage.naturalHeight){
            throw new Error("Wait for the banner picture to finish loading before downloading the PDF.");
          }
          var imageCanvas=document.createElement("canvas");
          imageCanvas.width=previewImage.naturalWidth;
          imageCanvas.height=previewImage.naturalHeight;
          var imageContext=imageCanvas.getContext("2d");
          if(!imageContext)throw new Error("The banner picture could not be prepared for the PDF.");
          imageContext.drawImage(previewImage,0,0);
          imageDataUrl=imageCanvas.toDataURL("image/png");
          imageWidth=imageCanvas.width;
          imageHeight=imageCanvas.height;
        }
        var doc=new JsPDF({
          orientation:bannerOrientation.value,
          unit:"mm",
          format:[layout.paperWidthMm,layout.paperHeightMm],
          compress:true
        });
        var imagePlacement=imageDataUrl
          ?getTarpaulinPdfImagePlacement(
            imageWidth,imageHeight,layout.bannerWidthMm,layout.bannerHeightMm,bannerImageFit.value
          )
          :null;
        var pageOrientation=layout.paperWidthMm>layout.paperHeightMm?"landscape":"portrait";
        var pageIndex=0;
        for(var row=0;row<layout.rows;row++){
          for(var column=0;column<layout.columns;column++){
            if(pageIndex>0)doc.addPage([layout.paperWidthMm,layout.paperHeightMm],pageOrientation);
            pageIndex++;
            var offsetX=column*layout.strideWidthMm;
            var offsetY=row*layout.strideHeightMm;
            var visibleArea=getTarpaulinPdfVisibleArea(layout,offsetX,offsetY);
            doc.setFillColor(255,255,255);
            doc.rect(
              tarpaulinPrintMarginsMm.left,tarpaulinPrintMarginsMm.top,
              layout.tileWidthMm,layout.tileHeightMm,"F"
            );
            doc.saveGraphicsState();
            doc.rect(
              tarpaulinPrintMarginsMm.left,tarpaulinPrintMarginsMm.top,
              visibleArea.width,visibleArea.height,null
            );
            doc.clip();
            doc.discardPath();
            doc.setFillColor(
              parseInt(bannerColor.value.slice(1,3),16),
              parseInt(bannerColor.value.slice(3,5),16),
              parseInt(bannerColor.value.slice(5,7),16)
            );
            doc.rect(
              tarpaulinPrintMarginsMm.left,tarpaulinPrintMarginsMm.top,
              visibleArea.width,visibleArea.height,"F"
            );
            if(imageDataUrl){
              doc.addImage(
                imageDataUrl,"PNG",
                tarpaulinPrintMarginsMm.left-offsetX+imagePlacement.x,
                tarpaulinPrintMarginsMm.top-offsetY+imagePlacement.y,
                imagePlacement.width,imagePlacement.height,
                "tarpaulin-banner","FAST"
              );
            }
            doc.restoreGraphicsState();
            drawTarpaulinPdfPageMarks(
              doc,layout,visibleArea,pageIndex,
              column<layout.columns-1,row<layout.rows-1
            );
          }
        }
        doc.setLineDashPattern([],0);
        doc.save("tarpaulin-banner.pdf");
        showTarpaulinNotice("Tiled PDF downloaded ("+layout.total+" "+(layout.total===1?"page":"pages")+").",false);
      }catch(error){
        showTarpaulinNotice(error.message||"The banner PDF could not be downloaded.",true);
      }finally{
        button.disabled=false;
      }
    };
    $("downloadTarpaulinSvg").onclick=async function(){
      var button=this;
      var dimensions=bannerDimensions();
      if(!dimensions){bannerWidth.reportValidity();bannerHeight.reportValidity();return}
      button.disabled=true;
      try{
        var imageDataUrl=bannerImageFile?await readImageAsDataUrl(bannerImageFile):"";
        var pictureSvg=imageDataUrl
          ?'<image href="'+imageDataUrl+'" x="0" y="0" width="'+dimensions.widthCm+'" height="'+dimensions.heightCm+'" preserveAspectRatio="'+(bannerImageFit.value==="stretch"?"none":bannerImageFit.value==="cover"?"xMidYMid slice":"xMidYMid meet")+'"/>'
          :"";
        var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+dimensions.width+dimensions.unit+'" height="'+dimensions.height+dimensions.unit+'" viewBox="0 0 '+dimensions.widthCm+' '+dimensions.heightCm+'"><rect width="100%" height="100%" fill="'+bannerColor.value+'"/>'+pictureSvg+"</svg>";
        var url=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml;charset=utf-8"}));
        var link=document.createElement("a");
        link.href=url;
        link.download="tarpaulin-design.svg";
        link.click();
        window.setTimeout(function(){URL.revokeObjectURL(url)},1000);
        showTarpaulinNotice("SVG design downloaded.",false);
      }catch(error){
        showTarpaulinNotice(error.message||"The banner design could not be exported.",true);
      }finally{
        button.disabled=false;
      }
    };
    function appendTarpaulinCutLine(page,direction,positionMm,startMm,lengthMm,isSeamTrim){
      var line=document.createElement("span");
      line.className="tarpaulin-print-cut-line "+direction+(isSeamTrim?" seam-trim":"");
      if(direction==="vertical"){
        line.style.left=positionMm+"mm";
        line.style.top=startMm+"mm";
        line.style.height=lengthMm+"mm";
      }else{
        line.style.top=positionMm+"mm";
        line.style.left=startMm+"mm";
        line.style.width=lengthMm+"mm";
      }
      page.appendChild(line);
    }
    function appendTarpaulinScissor(page,xMm,yMm,rotation){
      var marker=document.createElement("span");
      marker.className="tarpaulin-print-scissors";
      marker.setAttribute("aria-hidden","true");
      marker.style.left=xMm+"mm";
      marker.style.top=yMm+"mm";
      marker.style.transform="translate(-50%,-50%) rotate("+rotation+"deg)";
      marker.innerHTML='<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2.7"></circle><circle cx="5" cy="18" r="2.7"></circle><path d="M7.5 7.5 20 17M7.5 16.5 20 7"></path><circle cx="10" cy="12" r="1"></circle></svg>';
      page.appendChild(marker);
    }
    function createTarpaulinPrintPages(dimensions,layout){
      var pages=$("tarpaulinPrintPages");
      pages.textContent="";
      for(var row=0;row<layout.rows;row++){
        for(var column=0;column<layout.columns;column++){
          var offsetX=column*layout.strideWidthMm;
          var offsetY=row*layout.strideHeightMm;
          var page=document.createElement("section");
          page.className="tarpaulin-print-page";
          page.style.width=layout.paperWidthMm+"mm";
          page.style.height=layout.paperHeightMm+"mm";
          var tile=document.createElement("div");
          tile.className="tarpaulin-print-tile";
          tile.style.left=tarpaulinPrintMarginsMm.left+"mm";
          tile.style.top=tarpaulinPrintMarginsMm.top+"mm";
          tile.style.width=layout.tileWidthMm+"mm";
          tile.style.height=layout.tileHeightMm+"mm";
          var canvas=document.createElement("div");
          canvas.className="tarpaulin-print-canvas";
          canvas.style.left=(-offsetX)+"mm";
          canvas.style.top=(-offsetY)+"mm";
          canvas.style.width=layout.bannerWidthMm+"mm";
          canvas.style.height=layout.bannerHeightMm+"mm";
          canvas.style.backgroundColor=bannerColor.value;
          if(bannerImageFile){
            var image=document.createElement("img");
            image.className="tarpaulin-print-image";
            image.src=previewImage.src;
            image.alt="";
            image.style.objectFit=bannerImageFit.value==="stretch"?"fill":bannerImageFit.value;
            canvas.appendChild(image);
          }
          tile.appendChild(canvas);
          page.appendChild(tile);
          var visibleArea=getTarpaulinPdfVisibleArea(layout,offsetX,offsetY);
          var rightEdge=tarpaulinPrintMarginsMm.left+visibleArea.width;
          var bottomEdge=tarpaulinPrintMarginsMm.top+visibleArea.height;
          var hasNextColumn=column<layout.columns-1;
          var hasNextRow=row<layout.rows-1;
          var rightCutOffset=getTarpaulinRightCutOffsetMm(layout,visibleArea,hasNextColumn);
          var bottomCutOffset=getTarpaulinBottomCutOffsetMm(layout,visibleArea,hasNextRow);
          appendTarpaulinCutLine(page,"vertical",tarpaulinPrintMarginsMm.left,tarpaulinPrintMarginsMm.top,visibleArea.height);
          appendTarpaulinCutLine(page,"horizontal",tarpaulinPrintMarginsMm.top,tarpaulinPrintMarginsMm.left,visibleArea.width);
          if(hasNextColumn){
            appendTarpaulinCutLine(page,"vertical",rightEdge,tarpaulinPrintMarginsMm.top,visibleArea.height);
            appendTarpaulinCutLine(
              page,"vertical",tarpaulinPrintMarginsMm.left+layout.tileWidthMm,
              tarpaulinPrintMarginsMm.top,layout.tileHeightMm,true
            );
          }else if(rightCutOffset!==null){
            appendTarpaulinCutLine(
              page,"vertical",tarpaulinPrintMarginsMm.left+rightCutOffset,
              tarpaulinPrintMarginsMm.top,layout.tileHeightMm,true
            );
          }
          if(hasNextRow){
            appendTarpaulinCutLine(page,"horizontal",bottomEdge,tarpaulinPrintMarginsMm.left,visibleArea.width);
            appendTarpaulinCutLine(
              page,"horizontal",tarpaulinPrintMarginsMm.top+layout.tileHeightMm,
              tarpaulinPrintMarginsMm.left,layout.tileWidthMm,true
            );
          }else if(bottomCutOffset!==null){
            appendTarpaulinCutLine(
              page,"horizontal",tarpaulinPrintMarginsMm.top+bottomCutOffset,
              tarpaulinPrintMarginsMm.left,visibleArea.width,true
            );
          }
          var pageNumber=document.createElement("span");
          pageNumber.className="tarpaulin-print-page-number";
          pageNumber.textContent=String(row*layout.columns+column+1);
          pageNumber.style.left=(tarpaulinPrintMarginsMm.left/2)+"mm";
          pageNumber.style.top=(layout.paperHeightMm/2)+"mm";
          page.appendChild(pageNumber);
          if(hasNextColumn){
            appendTarpaulinScissor(
              page,
              tarpaulinPrintMarginsMm.left+layout.tileWidthMm+tarpaulinPrintMarginsMm.right/2,
              tarpaulinPrintMarginsMm.top+3,
              90
            );
          }
          if(hasNextRow){
            appendTarpaulinScissor(
              page,
              tarpaulinPrintMarginsMm.left+3,
              tarpaulinPrintMarginsMm.top+layout.tileHeightMm+tarpaulinPrintMarginsMm.bottom/2,
              0
            );
          }else if(bottomCutOffset!==null){
            appendTarpaulinScissor(
              page,
              tarpaulinPrintMarginsMm.left/2,
              tarpaulinPrintMarginsMm.top+bottomCutOffset,
              0
            );
          }
          if(!hasNextColumn&&rightCutOffset!==null){
            appendTarpaulinScissor(
              page,
              tarpaulinPrintMarginsMm.left+rightCutOffset,
              tarpaulinPrintMarginsMm.top+3,
              90
            );
          }
          pages.appendChild(page);
        }
      }
    }
    $("printTarpaulin").onclick=async function(){
      var button=this;
      var dimensions=bannerDimensions();
      if(!dimensions){bannerWidth.reportValidity();bannerHeight.reportValidity();return}
      var requestedGrid=bannerSheetLayout.value==="custom"?requestedTarpaulinSheetGrid():null;
      if(bannerSheetLayout.value==="custom"&&(!requestedGrid||tarpaulinSheetGridError)){
        if(!requestedGrid){
          bannerSheetsAcross.reportValidity();
          bannerSheetsDown.reportValidity();
        }
        showTarpaulinNotice(tarpaulinSheetGridError||"Enter valid sheet counts to prepare the tiled print.",true);
        return;
      }
      button.disabled=true;
      try{
        var layout=getTarpaulinPrintLayout(dimensions,bannerPaperSize.value,bannerOrientation.value,requestedGrid);
        createTarpaulinPrintPages(dimensions,layout);
        var printImages=Array.from($("tarpaulinPrintPages").querySelectorAll("img"));
        await Promise.all(printImages.map(function(image){return image.decode()}));
        tarpaulinPrintPageStyle.textContent="@page{size:"+tarpaulinPaperSizes[bannerPaperSize.value][bannerOrientation.value]+";margin:0}";
        document.head.appendChild(tarpaulinPrintPageStyle);
        $("tarpaulinPrintPages").hidden=false;
        document.body.classList.add("tools-printing");
        window.print();
      }catch(error){
        document.body.classList.remove("tools-printing");
        tarpaulinPrintPageStyle.remove();
        $("tarpaulinPrintPages").hidden=true;
        $("tarpaulinPrintPages").textContent="";
        showTarpaulinNotice(error.message||"The banner print pages could not be prepared.",true);
      }finally{
        button.disabled=false;
      }
    };
    window.addEventListener("afterprint",function(){
      document.body.classList.remove("tools-printing");
      tarpaulinPrintPageStyle.remove();
      $("tarpaulinPrintPages").hidden=true;
      $("tarpaulinPrintPages").textContent="";
    });

    var wheelCanvas=$("spinWheelCanvas"),wheelContext=wheelCanvas.getContext("2d");
    var wheelEntries=$("spinWheelEntries"),wheelAngle=0,wheelBusy=false,wheelNeedsRedraw=false;
    var wheelColors=["#2f7f70","#4776a8","#c07732","#9b5b83","#648b42","#5364a8","#b25346","#258994"];
    function getWheelEntries(){
      return wheelEntries.value.split(/\r?\n/).map(function(entry){return entry.trim()}).filter(Boolean);
    }
    function getAvailableWheelPupils(){
      return spinWheelRosterEntries.filter(function(entry){return !spinWheelRemovedIds.has(entry.id);});
    }
    function renderWheelRosterControls(){
      var availableCount=getAvailableWheelPupils().length;
      var removedEntries=spinWheelRosterEntries.filter(function(entry){return spinWheelRemovedIds.has(entry.id);});
      $("spinWheelAvailability").textContent=availableCount+" of "+spinWheelRosterEntries.length+" active pupil"+(spinWheelRosterEntries.length===1?"":"s")+" available";
      $("spinWheelReset").disabled=wheelBusy||removedEntries.length===0;
      $("spinWheelRemovedHelp").hidden=removedEntries.length===0;
      var removedList=$("spinWheelRemovedList");
      removedList.textContent="";
      $("spinWheelRemovedEmpty").hidden=removedEntries.length>0;
      removedEntries.forEach(function(entry,index){
        var item=document.createElement("li");
        var button=document.createElement("button");
        button.className="wheel-return-button";
        button.type="button";
        button.textContent=entry.name;
        button.setAttribute("aria-label","Return pupil "+(index+1)+", "+entry.name+" to the wheel");
        button.disabled=wheelBusy;
        button.onclick=function(){
          if(wheelBusy)return;
          if(returnSpinWheelPupil(entry.id)){
            $("spinWheelResult").textContent="Returned: "+entry.name;
            renderWheelRosterControls();
          }
        };
        item.appendChild(button);
        removedList.appendChild(item);
      });
    }
    function drawWheel(){
      var entries=getWheelEntries();
      var center=wheelCanvas.width/2,radius=center-8,segment=Math.PI*2/Math.max(entries.length,1);
      wheelContext.clearRect(0,0,wheelCanvas.width,wheelCanvas.height);
      entries.forEach(function(entry,index){
        var start=-Math.PI/2+index*segment,end=start+segment;
        wheelContext.beginPath();
        wheelContext.moveTo(center,center);
        wheelContext.arc(center,center,radius,start,end);
        wheelContext.closePath();
        wheelContext.fillStyle=wheelColors[index%wheelColors.length];
        wheelContext.fill();
        wheelContext.strokeStyle="#ffffff";
        wheelContext.lineWidth=3;
        wheelContext.stroke();
        wheelContext.save();
        wheelContext.translate(center,center);
        wheelContext.rotate(start+segment/2);
        wheelContext.textAlign="right";
        wheelContext.textBaseline="middle";
        wheelContext.fillStyle="#ffffff";
        wheelContext.font="bold "+Math.max(14,Math.min(25,Math.floor(230/entries.length)))+"px Arial, sans-serif";
        var label=entry.length>22?entry.slice(0,19)+"…":entry;
        wheelContext.fillText(label,radius-20,0,Math.max(80,radius*.7));
        wheelContext.restore();
      });
      wheelContext.beginPath();
      wheelContext.arc(center,center,26,0,Math.PI*2);
      wheelContext.fillStyle="#ffffff";
      wheelContext.fill();
    }
    wheelEntries.addEventListener("input",function(){
      if(wheelBusy){
        wheelNeedsRedraw=true;
        renderWheelRosterControls();
        return;
      }
      $("spinWheelResult").textContent="";
      drawWheel();
      renderWheelRosterControls();
    });
    $("spinWheelReset").onclick=function(){
      if(wheelBusy)return;
      if(resetSpinWheelPupils()){
        $("spinWheelResult").textContent="All removed pupils returned to the wheel.";
        renderWheelRosterControls();
      }
    };
    $("spinWheelButton").onclick=function(){
      var entries=getWheelEntries();
      var availablePupils=getAvailableWheelPupils();
      if(entries.length<2){
        $("spinWheelResult").textContent="At least two active pupils are needed from the selected roster section to spin.";
        return;
      }
      if(wheelBusy)return;
      wheelBusy=true;
      $("spinWheelButton").disabled=true;
      renderWheelRosterControls();
      $("spinWheelResult").textContent="Spinning…";
      var winnerIndex=Math.floor(Math.random()*entries.length);
      var winner=availablePupils[winnerIndex];
      var segmentDegrees=360/entries.length;
      var target=(360-(winnerIndex+.5)*segmentDegrees+360)%360;
      var current=((wheelAngle%360)+360)%360;
      wheelAngle+=1800+((target-current+360)%360);
      wheelCanvas.style.transform="rotate("+wheelAngle+"deg)";
      window.setTimeout(function(){
        wheelBusy=false;
        $("spinWheelButton").disabled=false;
        var removed=removeSpinWheelPupil(winner.id);
        if(!removed&&wheelNeedsRedraw){
          drawWheel();
          renderWheelRosterControls();
        }
        wheelNeedsRedraw=false;
        $("spinWheelResult").textContent="Selected: "+winner.name;
      },4600);
    };
    drawWheel();
    renderWheelRosterControls();
  })();
  $("settingsMenuButton").onclick=function(){$("menuToggle").click()};
  (function(){
    var button=$("updateButton"),notice=$("updateNotice"),manual=$("updateManualLink");
    var api=window.gradePortal;
    var mode="check";
    var pendingVersion=null,updateInProgress=false;
    function show(text,isError){
      notice.textContent=text;
      notice.classList.toggle("error",!!isError);
      manual.hidden=!isError;
    }
    function setMode(next,label){mode=next;button.textContent=label;button.disabled=false}
    function megabytes(bytes){return (bytes/1048576).toFixed(1)+" MB"}
    function setProgress(percent,transferred,total){
      $("updateProgress").hidden=false;
      $("updateProgressFill").style.width=percent+"%";
      $("updateProgressBar").setAttribute("aria-valuenow",String(percent));
      $("updateProgressPercent").textContent=percent+"%";
      $("updateProgressSize").textContent=total?megabytes(transferred)+" of "+megabytes(total):"";
    }
    function onStatus(status){
      if(status.state==="downloading"){
        button.disabled=true;
        button.textContent="Downloading…";
        setProgress(status.percent,status.transferred,status.total);
        show("Downloading update… "+status.percent+"%");
      }
    }
    if(!api||!api.checkForUpdates){
      button.hidden=true;
      manual.hidden=false;
      notice.textContent="Automatic updates are available in the installed desktop app.";
      return;
    }
    api.onUpdateStatus(onStatus);
    function refreshUpdateAlert(){
      var isTeacher=!$("topSettingsButton").hidden;
      var dismissed=pendingVersion&&window.sessionStorage.getItem("gracedesk-update-dismissed")===pendingVersion;
      var active=Boolean(pendingVersion)&&isTeacher&&!updateInProgress;
      $("topSettingsButton").classList.toggle("has-update-dot",active);
      $("navSettings").classList.toggle("has-update-dot",active);
      $("updateBanner").hidden=!(active&&!dismissed);
      if(active){
        $("updateBannerText").textContent="GraceDesk version "+pendingVersion+" is available.";
        $("topSettingsButton").title="Open settings — update available";
      }else{
        $("topSettingsButton").title="Open settings";
      }
    }
    window.refreshUpdateAlert=refreshUpdateAlert;
    api.onUpdateStatus(function(status){
      if(status.state==="available")pendingVersion=status.version;
      else if(status.state==="current")pendingVersion=null;
      else if(status.state==="downloading")updateInProgress=true;
      if(status.state==="available"||status.state==="current"){
        if(status.state==="available")show("Version "+status.version+" is available. Click Update to install it.");
        refreshUpdateAlert();
      }
    });
    api.getUpdateState().then(function(state){
      pendingVersion=state&&state.version||null;
      refreshUpdateAlert();
      if(pendingVersion)show("Version "+pendingVersion+" is available. Click Update to install it.");
    }).catch(function(){});
    $("updateBannerAction").onclick=function(){showDashboardPage("settings")};
    $("updateBannerClose").onclick=function(){
      if(pendingVersion)window.sessionStorage.setItem("gracedesk-update-dismissed",pendingVersion);
      refreshUpdateAlert();
    };
    button.onclick=async function(){
      button.disabled=true;
      try{
        show("Checking for updates…");
        var result=await api.checkForUpdates();
        if(result.state==="current"){show("You are using the latest version.");setMode("check","Update")}
        else if(result.state==="busy"){show("An update is already in progress.");button.disabled=false}
        else if(result.state!=="available"){show(result.message||"Updates are not available here.",true);setMode("check","Update")}
        else{
          show("Version "+result.version+" found. Downloading… 0%");
          setProgress(0,0,0);
          button.textContent="Downloading…";
          await api.downloadUpdate();
          setProgress(100,0,0);
          show("Download complete. Installing version "+result.version+". GraceDesk will close and reopen automatically…");
          button.textContent="Installing…";
          await api.installUpdate();
        }
      }catch(error){
        $("updateProgress").hidden=true;
        updateInProgress=false;
        refreshUpdateAlert();
        show("Update failed: "+error.message,true);
        setMode("check","Update");
      }
    };
  })();
  (function(){
    var desktop=window.gradePortal;
    var button=$("createDataBackupButton");
    var notice=$("dataBackupNotice");
    var status=$("dataBackupStatus");
    if(!desktop||!desktop.createDataBackup||!button)return;
    async function refreshBackups(){
      try{
        var backups=await desktop.listDataBackups();
        if(backups&&backups.length){
          var latest=new Date(backups[0].createdAt);
          status.textContent="Latest backup: "+latest.toLocaleString()+" · "+backups.length+" backup copy/copies retained";
        }else{
          status.textContent="No backup copy is available yet.";
        }
      }catch(error){
        status.textContent="Backup status could not be read.";
      }
    }
    button.onclick=async function(){
      button.disabled=true;
      notice.classList.remove("error");
      notice.textContent="Creating a local backup…";
      try{
        await desktop.createDataBackup();
        notice.textContent="Backup created successfully in the protected local backup folder.";
        await refreshBackups();
      }catch(error){
        notice.classList.add("error");
        notice.textContent="Backup failed: "+error.message;
      }finally{
        button.disabled=false;
      }
    };
    refreshBackups();
  })();
  $("performanceModeToggle").onclick=function(){
    applyPerformanceMode(!performanceModeEnabled);
    $("performanceNotice").classList.remove("error");
    try{
      window.localStorage.setItem("gradePortalPerformanceMode",performanceModeEnabled?"on":"off");
      performanceModeStorageError="";
      $("performanceNotice").textContent=performanceModeEnabled
        ?"Performance mode is on. Visual effects are reduced on this device."
        :"Performance mode is off. Standard visual effects are restored.";
    }catch(error){
      performanceModeStorageError="Performance mode is active for this visit, but could not be saved in this browser: "+error.message;
      $("performanceNotice").textContent=performanceModeStorageError;
      $("performanceNotice").classList.add("error");
    }
  };
  $("appearanceSetting").onchange=async function(){
    applyTheme(this.value);
    appearancePreferenceChanged=true;
    $("settingsNotice").classList.remove("error");
    try{
      if(appTheme==="system")window.localStorage.removeItem("gradePortalTheme");
      else window.localStorage.setItem("gradePortalTheme",appTheme);
    }catch(error){
      appearanceStorageError="Browser storage is unavailable; saving the appearance preference to the portal.";
      $("settingsNotice").textContent=appearanceStorageError;
      $("settingsNotice").classList.add("error");
    }
    try{
      await api("/api/preferences/appearance",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({theme:appTheme})
      });
      appearanceStorageError="";
      $("settingsNotice").textContent="Appearance preference saved.";
    }catch(error){
      appearanceStorageError="Appearance changed for this visit, but could not be saved: "+error.message;
      $("settingsNotice").textContent=appearanceStorageError;
      $("settingsNotice").classList.add("error");
    }
  };
  $("topProfileButton").onclick=function(){
    if(currentUser&&currentUser.role==="teacher")showDashboardPage("profile");
  };
  $("topSettingsButton").onclick=function(){
    if(currentUser&&currentUser.role==="teacher")showDashboardPage("settings");
  };
  function hasReason(status){return status==="Absent"||status==="AbsentX"||status==="Excused"}
  function reasonPlaceholder(status){return status==="Excused"?"Excuse reason (optional)":"Absence reason (optional)"}

  function paintAttendanceSelects(){
    document.querySelectorAll("#attendanceRows .attendance-day-select").forEach(function(select){
      select.dataset.status=select.value;
    });
  }

  function positionAttendanceHeader(){
    var offset=0;
    Array.from($("attendanceHead").rows).forEach(function(row){
      Array.from(row.cells).forEach(function(cell){cell.style.top=offset+"px"});
      offset+=row.getBoundingClientRect().height;
    });
  }
  window.addEventListener("resize",positionAttendanceHeader);

  function filterAttendanceRows(){
    var query=$("attendanceSearch").value.trim().toLowerCase();
    document.querySelectorAll("#attendanceRows tr").forEach(function(row){
      var nameCell=row.querySelector(".attendance-learner");
      if(nameCell)row.hidden=Boolean(query)&&!nameCell.textContent.toLowerCase().includes(query);
    });
  }

  function scrollAttendanceToToday(){
    var header=$("attendanceHead").querySelector("th.attendance-day.attendance-today");
    var wrap=$("attendanceTable").closest(".table-wrap");
    if(!header||!wrap)return;
    var headerRect=header.getBoundingClientRect();
    var wrapRect=wrap.getBoundingClientRect();
    wrap.scrollLeft+=headerRect.left-wrapRect.left-(wrap.clientWidth-headerRect.width)/2;
  }

  function stepAttendanceMonth(delta){
    var date=new Date(Number($("attendanceYear").value),Number($("attendanceMonth").value)-1+delta,1);
    var year=String(date.getFullYear());
    var nextMonth=year+"-"+String(date.getMonth()+1).padStart(2,"0");
    if(!Array.from($("attendanceYear").options).some(function(option){return option.value===year})
      ||!isAttendanceMonthAllowed(nextMonth,attendanceSchoolYearRange()))return;
    $("attendanceYear").value=year;
    $("attendanceMonth").value=String(date.getMonth()+1);
    changeAttendanceMonth();
  }

  function updateAttendanceNav(){
    var range=attendanceSchoolYearRange();
    var month=selectedAttendanceMonth();
    if(!range){
      $("attendancePrevMonth").disabled=true;
      $("attendanceNextMonth").disabled=true;
      $("attendanceToday").disabled=true;
      return;
    }
    $("attendancePrevMonth").disabled=month<=range.startDate.slice(0,7);
    $("attendanceNextMonth").disabled=month>=range.endDate.slice(0,7);
    var now=new Date();
    var todayMonth=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
    $("attendanceToday").disabled=!isAttendanceMonthAllowed(todayMonth,range);
  }

  function changeAttendanceMonth(){
    var range=attendanceSchoolYearRange();
    if(!range)return;
    refreshAttendanceYears();
    if(!isAttendanceMonthAllowed(selectedAttendanceMonth(),range))return;
    if(attendanceDirty&&!window.confirm("Discard unsaved attendance changes?")){
      $("attendanceYear").value=activeAttendanceMonth.slice(0,4);
      $("attendanceMonth").value=String(Number(activeAttendanceMonth.slice(5,7)));
      refreshAttendanceYears();
      return;
    }
    attendanceDirty=false;
    updateAttendanceNav();
    loadAttendance();
  }
  $("attendanceMonth").onchange=changeAttendanceMonth;
  $("attendanceYear").onchange=changeAttendanceMonth;
  $("attendancePrevMonth").onclick=function(){stepAttendanceMonth(-1)};
  $("attendanceNextMonth").onclick=function(){stepAttendanceMonth(1)};
  $("attendanceToday").onclick=function(){
    var now=new Date();
    var todayMonth=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
    if(!isAttendanceMonthAllowed(todayMonth,attendanceSchoolYearRange()))return;
    if(selectedAttendanceMonth()===todayMonth){
      scrollAttendanceToToday();
      return;
    }
    $("attendanceYear").value=String(now.getFullYear());
    $("attendanceMonth").value=String(now.getMonth()+1);
    changeAttendanceMonth();
  };
  $("attendanceSearch").oninput=filterAttendanceRows;
  $("attendanceRows").addEventListener("change",function(event){
    if(event.target.classList.contains("attendance-day-select"))event.target.dataset.status=event.target.value;
  });
  window.setInterval(function(){
    if(document.visibilityState==="visible"){
      $("attendanceUnsaved").hidden=!attendanceDirty;
    }
  },1000);
  $("attendanceMonthlyTab").onclick=function(){setAttendanceTab(false)};
  $("attendanceSummaryTab").onclick=function(){setAttendanceTab(true)};
  $("refreshAttendanceSummary").onclick=loadAttendanceSummary;
  $("attendanceAddStudent").onclick=function(){showDashboardPage("students")};
  $("clearAttendanceMonth").onclick=async function(){
    var month=selectedAttendanceMonth();
    if(!attendanceData||attendanceData.month!==month){
      $("attendanceNotice").textContent="Load the selected month before clearing its attendance.";
      $("attendanceNotice").classList.add("error");
      return;
    }
    if(!window.confirm("Clear saved attendance and Holiday/No Class dates within the configured school-year range for "+month+"? Unsaved changes will be discarded. Cleared no-class dates will return to Class Day. Other months and monthly learner status notes will remain unchanged."))return;
    var button=this;
    var editorControls=Array.from(document.querySelectorAll(
      "#attendanceRows select[data-student-id],#attendanceRows select.attendance-remark-select,#attendanceRows input.attendance-status-date,#attendanceRows input.attendance-reason-input,#attendanceHead .attendance-day-type,#attendanceHead .attendance-no-class-reason"
    ));
    var previousDisabledStates=editorControls.map(function(control){return control.disabled});
    editorControls.forEach(function(control){control.disabled=true});
    button.disabled=true;
    button.textContent="Clearing...";
    $("saveAttendance").disabled=true;
    $("importSF2").disabled=true;
    $("downloadSF2").disabled=true;
    $("attendanceMonth").disabled=true;
    $("attendanceYear").disabled=true;
    $("attendanceNotice").textContent="";
    $("attendanceNotice").classList.remove("error");
    try{
      var result=await api("/api/attendance/month?month="+encodeURIComponent(month),{method:"DELETE"});
      if(result.month!==month)throw new Error("The server cleared a different month than the one selected.");
      attendanceDirty=false;
      await loadAttendance();
      if($("attendanceCount").textContent==="Unable to load"
        ||!attendanceData||attendanceData.month!==month){
        throw new Error("Attendance was cleared, but the selected month could not be reloaded. Refresh it to verify the result.");
      }
      if(Array.from($("attendanceRows").querySelectorAll(".attendance-day-select"))
        .some(function(select){return select.value!==""})){
        throw new Error("Attendance was cleared, but some dropdowns did not reset to -. Refresh the selected month to verify the result.");
      }
      $("attendanceNotice").textContent="Cleared "+result.deleted+" daily attendance entr"+(result.deleted===1?"y":"ies")+" and "+result.noClassDatesCleared+" Holiday/No Class date"+(result.noClassDatesCleared===1?"":"s")+" within the school-year date range for "+month+". Those dates are now Class Day; other months and monthly learner status notes were not changed.";
      await loadAttendanceSummary();
    }catch(error){
      $("attendanceNotice").textContent=error.message;
      $("attendanceNotice").classList.add("error");
    }finally{
      editorControls.forEach(function(control,index){
        if(document.contains(control))control.disabled=previousDisabledStates[index];
      });
      button.disabled=!attendanceData
        ||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0
        ||$("attendanceCount").textContent==="Unable to load";
      button.textContent="Clear Month Attendance";
      $("saveAttendance").disabled=!attendanceData
        ||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0
        ||$("attendanceCount").textContent==="Unable to load";
      $("importSF2").disabled=false;
      $("downloadSF2").disabled=false;
      $("attendanceMonth").disabled=false;
      $("attendanceYear").disabled=false;
    }
  };
  $("importSF2").onclick=function(){
    $("sf2File").click();
  };
  $("sf2File").onchange=async function(){
    var file=this.files&&this.files[0];
    if(!file)return;
    if(!/\.xlsx$/i.test(file.name)){
      $("attendanceNotice").textContent="Choose an SF2 workbook in .xlsx format.";
      $("attendanceNotice").classList.add("error");
      this.value="";
      return;
    }
    if(attendanceDirty&&!window.confirm("Importing SF2 will replace saved attendance for matching learners in this month and discard unsaved changes. Continue?")){
      this.value="";
      return;
    }
    var month=selectedAttendanceMonth();
    var button=$("importSF2");
    button.disabled=true;
    button.textContent="Importing SF2...";
    $("downloadSF2").disabled=true;
    $("saveAttendance").disabled=true;
    $("clearAttendanceMonth").disabled=true;
    $("attendanceMonth").disabled=true;
    $("attendanceYear").disabled=true;
    $("attendanceRows").querySelectorAll("select[data-student-id],select.attendance-remark-select,input.attendance-status-date,input.attendance-reason-input").forEach(function(input){input.disabled=true});
    $("attendanceHead").querySelectorAll(".attendance-day-type,.attendance-no-class-reason").forEach(function(input){input.disabled=true});
    $("attendanceNotice").textContent="";
    $("attendanceNotice").classList.remove("error");
    try{
      var result=await api("/api/attendance/month/import?month="+encodeURIComponent(month),{
        method:"POST",
        headers:{"Content-Type":"application/octet-stream"},
        body:file
      });
      attendanceDirty=false;
      await loadAttendance();
      if($("attendanceCount").textContent==="Unable to load"){
        throw new Error("SF2 was imported, but the attendance sheet could not be reloaded. Refresh the selected month to verify it.");
      }
      $("attendanceNotice").textContent="Imported "+result.imported+" learner"+(result.imported===1?"":"s")+" and "+result.importedDays+" school-day record"+(result.importedDays===1?"":"s")+" for "+month+". Other months and roster learners not in the SF2 were left unchanged.";
    }catch(error){
      $("attendanceNotice").textContent=error.message;
      $("attendanceNotice").classList.add("error");
    }finally{
      button.disabled=false;
      button.textContent="Import SF2";
      $("downloadSF2").disabled=false;
      $("attendanceMonth").disabled=false;
      $("attendanceYear").disabled=false;
      $("saveAttendance").disabled=!attendanceData||attendanceData.students.length===0;
      $("clearAttendanceMonth").disabled=!attendanceData||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0;
      $("attendanceRows").querySelectorAll("select[data-student-id],select.attendance-remark-select,input.attendance-status-date,input.attendance-reason-input").forEach(function(input){
        var dayIndex=Number(input.dataset.dayIndex);
        var studentRecord=attendanceData.students.find(function(student){return student.id===input.dataset.studentId});
        input.disabled=input.classList.contains("attendance-day-select")
          ||input.classList.contains("attendance-reason-input")
          ?attendanceData.noClassDates.includes(attendanceData.dates[dayIndex])
            ||Boolean(studentRecord&&studentRecord.lockedDates.includes(attendanceData.dates[dayIndex]))
          :input.classList.contains("attendance-status-date")
            ?Boolean(studentRecord&&studentRecord.statusInherited)
            :false;
      });
      $("attendanceHead").querySelectorAll(".attendance-day-type,.attendance-no-class-reason").forEach(function(input){input.disabled=false});
      this.value="";
    }
  };
  $("downloadSF2").onclick=async function(){
    var month=selectedAttendanceMonth();
    if(attendanceDirty){
      if(!window.confirm("Save your unsaved attendance changes before downloading the SF2?"))return;
      await $("saveAttendance").onclick();
      if(attendanceDirty)return;
    }
    var button=this;
    button.disabled=true;
    button.textContent="Preparing SF2...";
    $("importSF2").disabled=true;
    $("saveAttendance").disabled=true;
    $("clearAttendanceMonth").disabled=true;
    $("attendanceMonth").disabled=true;
    $("attendanceYear").disabled=true;
    $("attendanceNotice").textContent="";
    $("attendanceNotice").classList.remove("error");
    try{
      var exportParams=new URLSearchParams({month:month});
      if(activeStudentSection!=="__all__")exportParams.set("section",activeStudentSection);
      var response=await fetch("/api/attendance/month/export?"+exportParams.toString());
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to download the selected month's SF2.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var filenameMatch=disposition.match(/filename="([^"]+)"/i);
      if(!filenameMatch)throw new Error("The server did not provide an SF2 filename.");
      var filename=filenameMatch[1];
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=filename;
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      $("attendanceNotice").textContent="Your SF2 download for "+month+" has started.";
    }catch(error){
      $("attendanceNotice").textContent=error.message;
      $("attendanceNotice").classList.add("error");
    }finally{
      button.disabled=false;
      button.textContent="Download SF2";
      $("importSF2").disabled=false;
      $("attendanceMonth").disabled=false;
      $("attendanceYear").disabled=false;
      $("saveAttendance").disabled=!attendanceData
        ||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0;
      $("clearAttendanceMonth").disabled=!attendanceData
        ||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0;
    }
  };
  $("saveAttendance").onclick=async function(){
    var button=$("saveAttendance");
    var month=activeAttendanceMonth;
    var records=attendanceData.students.map(function(student){
      return {
        studentId:student.id,
        attendance:student.attendance,
        reasons:student.reasons,
        remarks:student.remarks||"",
        statusDate:student.statusDate||"",
      };
    });
    var noClassReasons={};
    attendanceData.noClassDates.forEach(function(date){
      noClassReasons[date]=String((attendanceData.noClassReasons||{})[date]||"").trim();
    });
    button.disabled=true;
    button.textContent="Saving...";
    $("clearAttendanceMonth").disabled=true;
    $("attendanceMonth").disabled=true;
    $("attendanceYear").disabled=true;
    $("attendanceRows").querySelectorAll("select[data-student-id],select.attendance-remark-select,input.attendance-status-date,input.attendance-reason-input").forEach(function(input){input.disabled=true});
    $("attendanceHead").querySelectorAll(".attendance-day-type,.attendance-no-class-reason").forEach(function(input){input.disabled=true});
    $("attendanceNotice").textContent="";
    $("attendanceNotice").classList.remove("error");
    try{
      var result=await api("/api/attendance/month",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({month:month,records:records,noClassDates:attendanceData.noClassDates,noClassReasons:noClassReasons})
      });
      if(!attendanceData||attendanceData.month!==result.month)throw new Error("Attendance was saved, but the displayed month changed. Reload the attendance page.");
      attendanceDirty=false;
      await loadAttendance();
      if($("attendanceCount").textContent==="Unable to load"
        ||!attendanceData||attendanceData.month!==result.month){
        throw new Error("Attendance was saved, but the updated status could not be reloaded. Refresh the selected month to verify it.");
      }
      $("attendanceNotice").textContent="Monthly attendance saved.";
    }catch(error){
      $("attendanceNotice").textContent=error.message;
      $("attendanceNotice").classList.add("error");
    }finally{
      $("attendanceMonth").disabled=false;
      $("attendanceYear").disabled=false;
      $("attendanceRows").querySelectorAll("select[data-student-id],select.attendance-remark-select,input.attendance-status-date,input.attendance-reason-input").forEach(function(input){
        var dayIndex=Number(input.dataset.dayIndex);
        var studentRecord=attendanceData.students.find(function(student){return student.id===input.dataset.studentId});
        input.disabled=input.classList.contains("attendance-day-select")
          ||input.classList.contains("attendance-reason-input")
          ?attendanceData.noClassDates.includes(attendanceData.dates[dayIndex])
            ||Boolean(studentRecord&&studentRecord.lockedDates.includes(attendanceData.dates[dayIndex]))
          :input.classList.contains("attendance-status-date")
            ?Boolean(studentRecord&&studentRecord.statusInherited)
            :false;
      });
      $("attendanceHead").querySelectorAll(".attendance-day-type,.attendance-no-class-reason").forEach(function(input){input.disabled=false});
      button.disabled=!attendanceData||attendanceData.students.length===0;
      $("clearAttendanceMonth").disabled=!attendanceData||attendanceData.month!==selectedAttendanceMonth()
        ||attendanceData.students.length===0;
      button.textContent="Save Attendance";
    }
  };
  function formatRmaPercentage(value){
    return typeof value==="number"&&Number.isFinite(value)?value.toFixed(2)+"%":"Data Not Yet Available";
  }

  function createRmaSvgElement(name,attributes,text){
    var element=document.createElementNS("http://www.w3.org/2000/svg",name);
    Object.keys(attributes||{}).forEach(function(attribute){
      element.setAttribute(attribute,attributes[attribute]);
    });
    if(text!==undefined)element.textContent=text;
    return element;
  }

  function renderRmaMasteryChart(students,period){
    var container=$("rmaMasteryChart");
    container.replaceChildren();
    var levels=rmaData.template.grades[0].masteryBands.map(function(band){return band.level});
    var colors=["#287a54","#3478b8","#4d8f78","#d18a1f","#bd4e44"];
    var counts=levels.map(function(level){
      return students.filter(function(student){
        var assessment=student.assessments[period];
        return assessment.scoringMethod==="template"&&assessment.masteryLevel===level;
      }).length;
    });
    var chart=createRmaSvgElement("svg",{viewBox:"0 0 640 230",class:"rma-chart",role:"img","aria-label":"Class mastery distribution"});
    chart.append(createRmaSvgElement("title",{},"Class mastery distribution for "+period));
    var maxCount=Math.max(1,...counts);
    levels.forEach(function(level,index){
      var y=35+index*46;
      chart.append(
        createRmaSvgElement("text",{x:2,y:y+16},level),
        createRmaSvgElement("rect",{x:178,y:y,width:390*counts[index]/maxCount,height:24,rx:5,fill:colors[index]}),
        createRmaSvgElement("text",{x:580,y:y+17,"font-weight":"700"},String(counts[index]))
      );
    });
    if(counts.every(function(count){return count===0})){
      chart.append(createRmaSvgElement("text",{x:320,y:220,"text-anchor":"middle"},"No scored learners in this cycle yet."));
    }
    container.append(chart);
  }

  function renderRmaTrendChart(){
    var container=$("rmaTrendChart");
    container.replaceChildren();
    var students=filterStudentsForActiveSection(rmaData.students);
    var cycles=rmaData.periods.map(function(period){
      var values=students.filter(function(student){
        return student.assessments[period].scoringMethod==="template"
          &&typeof student.assessments[period].percentageScore==="number";
      }).map(function(student){return student.assessments[period].percentageScore});
      return {period:period,average:values.length
        ?values.reduce(function(total,value){return total+value},0)/values.length
        :null};
    });
    var chart=createRmaSvgElement("svg",{viewBox:"0 0 640 230",class:"rma-chart",role:"img","aria-label":"Average RMA score trend"});
    chart.append(createRmaSvgElement("title",{},"Average percentage score by assessment cycle"));
    var left=56,right=610,top=22,bottom=174;
    [0,25,50,75,100].forEach(function(value){
      var y=bottom-(bottom-top)*value/100;
      chart.append(
        createRmaSvgElement("line",{x1:left,y1:y,x2:right,y2:y,stroke:"var(--line)"}),
        createRmaSvgElement("text",{x:left-9,y:y+4,"text-anchor":"end"},String(value))
      );
    });
    var points=cycles.map(function(cycle,index){
      return {x:left+(right-left)*index/Math.max(1,cycles.length-1),y:cycle.average===null
        ?null:bottom-(bottom-top)*cycle.average/100,cycle:cycle};
    });
    for(var index=1;index<points.length;index++){
      if(points[index-1].y===null||points[index].y===null)continue;
      chart.append(createRmaSvgElement("line",{
        x1:points[index-1].x,y1:points[index-1].y,x2:points[index].x,y2:points[index].y,
        stroke:"var(--accent)","stroke-width":3
      }));
    }
    points.forEach(function(point){
      chart.append(createRmaSvgElement("text",{x:point.x,y:202,"text-anchor":"middle"},point.cycle.period));
      if(point.y!==null){
        chart.append(
          createRmaSvgElement("circle",{cx:point.x,cy:point.y,r:6,fill:"var(--accent)"}),
          createRmaSvgElement("text",{x:point.x,y:point.y-11,"text-anchor":"middle","font-weight":"700"},point.cycle.average.toFixed(1)+"%")
        );
      }
    });
    if(points.every(function(point){return point.y===null})){
      chart.append(createRmaSvgElement("text",{x:320,y:220,"text-anchor":"middle"},"Class trend will appear after scores are recorded."));
    }
    container.append(chart);
  }

  function renderRmaLearnerChart(){
    var students=rmaData?filterStudentsForActiveSection(rmaData.students):[];
    var selector=$("rmaLearnerSelect");
    var selectedId=selector.value;
    selector.replaceChildren();
    students.forEach(function(student){
      selector.add(new Option(student.name,student.id));
    });
    if(students.some(function(student){return student.id===selectedId}))selector.value=selectedId;
    var student=students.find(function(entry){return entry.id===selector.value});
    var container=$("rmaLearnerChart");
    container.replaceChildren();
    var chart=createRmaSvgElement("svg",{viewBox:"0 0 640 230",class:"rma-chart",role:"img",
      "aria-label":student?"RMA progress for "+student.name:"Learner RMA progress"});
    chart.append(createRmaSvgElement("title",{},student?"RMA progress for "+student.name:"Learner RMA progress"));
    var left=56,right=610,top=22,bottom=174;
    [0,25,50,75,100].forEach(function(value){
      var y=bottom-(bottom-top)*value/100;
      chart.append(
        createRmaSvgElement("line",{x1:left,y1:y,x2:right,y2:y,stroke:"var(--line)"}),
        createRmaSvgElement("text",{x:left-9,y:y+4,"text-anchor":"end"},String(value))
      );
    });
    if(student){
      var points=rmaData.periods.map(function(period,index){
        var assessment=student.assessments[period];
        return {
          x:left+(right-left)*index/Math.max(1,rmaData.periods.length-1),
          y:assessment.scoringMethod==="template"&&typeof assessment.percentageScore==="number"
            ?bottom-(bottom-top)*assessment.percentageScore/100:null,
          period:period,
          assessment:assessment
        };
      });
      for(var index=1;index<points.length;index++){
        if(points[index-1].y===null||points[index].y===null)continue;
        chart.append(createRmaSvgElement("line",{
          x1:points[index-1].x,y1:points[index-1].y,x2:points[index].x,y2:points[index].y,
          stroke:"var(--accent)","stroke-width":3
        }));
      }
      points.forEach(function(point){
        chart.append(createRmaSvgElement("text",{x:point.x,y:202,"text-anchor":"middle"},point.period));
        if(point.y!==null){
          var marker=createRmaSvgElement("circle",{cx:point.x,cy:point.y,r:7,fill:"var(--accent)"});
          marker.append(createRmaSvgElement("title",{},point.period+": "+formatRmaPercentage(point.assessment.percentageScore)
            +" — "+point.assessment.masteryLevel));
          chart.append(marker,createRmaSvgElement("text",{x:point.x,y:point.y-12,"text-anchor":"middle","font-weight":"700"},
            point.assessment.percentageScore.toFixed(1)+"%"));
        }
      });
    }
    if(!student||!rmaData.periods.some(function(period){
      return student.assessments[period].scoringMethod==="template"
        &&typeof student.assessments[period].percentageScore==="number";
    })){
      chart.append(createRmaSvgElement("text",{x:320,y:220,"text-anchor":"middle"},"No scored assessments are available for this learner."));
    }
    container.append(chart);
  }

  function renderRmaReport(){
    if(!rmaData)return;
    var period=rmaPeriod;
    var students=filterStudentsForActiveSection(rmaData.students);
    var assessments=students.map(function(student){return student.assessments[period]});
    var assessed=assessments.filter(function(assessment){return Boolean(assessment.assessedDate)});
    var scored=assessed.filter(function(assessment){
      return assessment.scoringMethod==="template"&&typeof assessment.percentageScore==="number";
    });
    var average=scored.length?scored.reduce(function(total,assessment){return total+assessment.percentageScore},0)/scored.length:null;
    $("rmaAssessedCount").textContent=String(assessed.length);
    $("rmaClassAverage").textContent=average===null?"Data Not Yet Available":average.toFixed(2)+"%";
    $("rmaHighestScore").textContent=scored.length
      ?Math.max.apply(null,scored.map(function(assessment){return assessment.percentageScore})).toFixed(2)+"%"
      :"Data Not Yet Available";
    $("rmaLowestScore").textContent=scored.length
      ?Math.min.apply(null,scored.map(function(assessment){return assessment.percentageScore})).toFixed(2)+"%"
      :"Data Not Yet Available";
    $("rmaMasteryCaption").textContent=period+" template levelling distribution";
    var domainRows=$("rmaDomainRows");
    domainRows.replaceChildren();
    rmaData.template.domains.forEach(function(domain){
      var results=scored.map(function(assessment){
        return (assessment.domainScores||[]).concat(assessment.cognitiveDomainScores||[])
          .find(function(result){return result.key===domain.key});
      }).filter(Boolean);
      var averageDomain=results.length
        ?results.reduce(function(total,result){return total+result.percentageScore},0)/results.length:null;
      var met=results.filter(function(result){return result.meetsBenchmark}).length;
      var row=document.createElement("tr");
      [
        domain.label,
        averageDomain===null?"Data Not Yet Available":averageDomain.toFixed(2)+"%",
        met,results.length,results.length?(met/results.length*100).toFixed(1)+"%":"Data Not Yet Available"
      ].forEach(function(value){var cell=document.createElement("td");cell.textContent=String(value);row.appendChild(cell)});
      domainRows.appendChild(row);
    });
    var bandSummary=rmaData.template.grades[0].masteryBands.map(function(band){
      var count=scored.filter(function(assessment){return assessment.masteryLevel===band.level}).length;
      return band.level+": "+count+" ("+(scored.length?(count/scored.length*100).toFixed(1):"0.0")+"%)";
    });
    $("rmaClassAnalysis").textContent=scored.length
      ?"Class performance ("+period+"): "+bandSummary.join("; ")+". "
        +(scored.some(function(assessment){return assessment.masteryLevel==="Emerging (Not Proficient)"
          ||assessment.masteryLevel==="Emerging (Low Proficient)"})
          ?"Recommended class-wide intervention: provide targeted remediation and reteaching; use the domain benchmark results to prioritize support."
          :"Review learner-level item responses and provide differentiated practice and enrichment.")
      :assessed.length?"Template-aligned class analysis is not available for legacy scores. Re-enter those assessments using the RMA item scoresheet."
        :"Class performance ("+period+"): Data Not Yet Available. Enter assessment dates and item-level scores to generate class analysis.";
    renderRmaMasteryChart(students,period);
    renderRmaTrendChart();
    renderRmaLearnerChart();
  }

  function rmaAge(birthdate,assessedDate){
    if(!birthdate||!assessedDate)return "Data Not Yet Available";
    var birth=new Date(birthdate+"T00:00:00.000Z");
    var assessed=new Date(assessedDate+"T00:00:00.000Z");
    if(Number.isNaN(birth.getTime())||Number.isNaN(assessed.getTime())||assessed<birth)return "Data Not Yet Available";
    var age=assessed.getUTCFullYear()-birth.getUTCFullYear();
    if(assessed.getUTCMonth()<birth.getUTCMonth()
      ||(assessed.getUTCMonth()===birth.getUTCMonth()&&assessed.getUTCDate()<birth.getUTCDate()))age--;
    return String(age);
  }

  function renderRmaEntry(){
    if(!rmaData)return;
    var students=filterStudentsForActiveSection(rmaData.students);
    $("rmaEntryTitle").textContent="Record "+rmaPeriod+" Assessment";
    $("rmaEntryCount").textContent=students.length+" learners";
    $("rmaEntryEmpty").hidden=students.length>0;
    $("rmaGradeSelect").value=rmaGradeLevel;
    var selectedGrade=rmaData.template.grades.find(function(grade){return grade.gradeLevel===rmaGradeLevel});
    $("rmaGradeInstructions").textContent=rmaGradeLevel+" uses a "+selectedGrade.maximumScore
      +"-point maximum. Open a learner's form and select the items answered correctly.";
    var rows=$("rmaEntryRows");
    rows.replaceChildren();
    students.forEach(function(student){
      var assessment=student.assessments[rmaPeriod];
      var row=document.createElement("tr");
      row.dataset.studentId=student.id;
      var nameCell=document.createElement("td");
      nameCell.className="rma-learner-name";
      nameCell.textContent=student.name;
      row.appendChild(nameCell);
      var actionCell=document.createElement("td");
      actionCell.className="rma-entry-action";
      var addScore=document.createElement("button");
      addScore.type="button";
      addScore.className="btn rma-add-score";
      addScore.dataset.studentId=student.id;
      addScore.textContent=assessment.scoringMethod==="template"?"Edit Score":"Add Score";
      addScore.setAttribute("aria-label",(assessment.scoringMethod==="template"?"Edit":"Add")
        +" RMA score for "+student.name);
      actionCell.appendChild(addScore);
      row.appendChild(actionCell);
      rows.appendChild(row);
      var resultRow=document.createElement("tr");
      resultRow.className="rma-result-row";
      var resultCell=document.createElement("td");
      resultCell.colSpan=2;
      var summary=document.createElement("div");
      summary.className="rma-result-summary";
      if(assessment.scoringMethod==="template"&&assessment.assessedDate){
        var scoreLine=document.createElement("strong");
        scoreLine.textContent="Score: "+assessment.rawScore+" / "+assessment.totalItems+" points · "
          +formatRmaPercentage(assessment.percentageScore)+" · "+assessment.masteryLevel;
        summary.appendChild(scoreLine);
        if(assessment.remarks){
          var remarks=document.createElement("div");
          remarks.textContent=assessment.remarks;
          summary.appendChild(remarks);
        }
      }else if(assessment.scoringMethod==="legacy"){
        summary.textContent="Legacy overall score: "+formatRmaPercentage(assessment.percentageScore)
          +". Re-enter this assessment using the item checklist to generate template-aligned results.";
      }else{
        summary.textContent="No score recorded for "+rmaPeriod+".";
      }
      resultCell.appendChild(summary);
      resultRow.appendChild(resultCell);
      rows.appendChild(resultRow);
    });
    rmaDirty=false;
  }

  function openRmaAssessment(studentId){
    var student=rmaData.students.find(function(entry){return entry.id===studentId});
    if(!student)return;
    var assessment=student.assessments[rmaPeriod];
    rmaEditingStudentId=studentId;
    $("rmaAssessmentTitle").textContent="Record "+rmaPeriod+" assessment";
    $("rmaAssessmentSubtitle").textContent=student.name+" · "+(student.lrn||"LRN unavailable");
    $("rmaAssessmentDate").value=assessment.assessedDate||"";
    $("rmaAssessmentDate").defaultValue=$("rmaAssessmentDate").value;
    $("rmaAssessmentAge").textContent=student.birthdate?"Age at assessment: "+rmaAge(student.birthdate,assessment.assessedDate):"";
    $("rmaAssessmentError").textContent="";
    $("rmaAssessmentLegacyNote").hidden=assessment.scoringMethod!=="legacy";
    $("rmaAssessmentLegacyNote").textContent=assessment.scoringMethod==="legacy"
      ?"This learner has a previously saved overall score. Saving this item checklist will replace it with template-based scoring; unchecked items count as zero."
      :"";
    var itemContainer=$("rmaAssessmentItems");
    itemContainer.replaceChildren();
    var gradeIndex=rmaData.template.grades.findIndex(function(grade){return grade.gradeLevel===rmaGradeLevel});
    var applicableItems=rmaData.template.items.filter(function(item){
      return rmaData.template.grades.findIndex(function(grade){return grade.gradeLevel===item.gradeLevel})<=gradeIndex;
    });
    ["Grade 4","Grade 5","Grade 6"].forEach(function(gradeLevel){
      var items=applicableItems.filter(function(item){return item.gradeLevel===gradeLevel});
      if(!items.length)return;
      var group=document.createElement("section");
      group.className="rma-item-group";
      var heading=document.createElement("h3");
      heading.textContent=gradeLevel+" items";
      group.appendChild(heading);
      var grid=document.createElement("div");
      grid.className="rma-item-grid";
      items.forEach(function(item){
        var wrapper=document.createElement("div");
        wrapper.className="rma-item-field";
        var input=item.maximum===1?document.createElement("input"):document.createElement("select");
        if(item.maximum===1){
          input.type="checkbox";
        }else{
          var notAnswered=document.createElement("option");
          notAnswered.value="";
          notAnswered.textContent="Choose score";
          input.appendChild(notAnswered);
          for(var point=0;point<=item.maximum;point++){
            var scoreOption=document.createElement("option");
            scoreOption.value=String(point);
            scoreOption.textContent=point+" point"+(point===1?"":"s");
            input.appendChild(scoreOption);
          }
        }
        input.className="rma-entry-input";
        input.dataset.field="correctItem";
        input.dataset.itemKey=item.key;
        input.dataset.maximum=String(item.maximum);
        var itemId="rmaCorrectItem"+item.key;
        input.id=itemId;
        var originalScore=Number(assessment.itemScores&&assessment.itemScores[item.key]||0);
        input.dataset.originalScore=String(originalScore);
        input.dataset.touched="false";
        if(item.maximum===1){
          input.checked=originalScore===item.maximum;
          input.defaultChecked=input.checked;
          input.setAttribute("aria-label","Item "+item.label+" answered correctly, worth one point");
        }else{
          input.value=assessment.assessedDate?String(originalScore):"";
          input.dataset.initialValue=input.value;
          input.setAttribute("aria-label","Score for item "+item.label+", worth up to "+item.maximum+" points");
        }
        var label=document.createElement("label");
        label.htmlFor=itemId;
        label.textContent="Item "+item.label+" · "+item.maximum+" "+(item.maximum===1?"point":"points");
        wrapper.append(input,label);
        if(item.maximum>1&&originalScore>0&&originalScore<item.maximum){
          var partial=document.createElement("span");
          partial.className="rma-item-partial";
          partial.textContent="Previously saved partial score "+originalScore+"/"+item.maximum+" (kept unless changed)";
          label.appendChild(partial);
        }
        grid.appendChild(wrapper);
      });
      group.appendChild(grid);
      itemContainer.appendChild(group);
    });
    var domainContainer=$("rmaAssessmentDomains");
    domainContainer.replaceChildren();
    rmaData.template.domains.forEach(function(domain){
      var block=document.createElement("div");
      block.dataset.domainPreview=domain.key;
      var title=document.createElement("strong");
      title.textContent=domain.label;
      var value=document.createElement("span");
      block.append(title,value);
      domainContainer.appendChild(block);
    });
    var narrative=$("rmaAssessmentNarrative");
    narrative.replaceChildren();
    [
      ["remarks","Automatically generated remarks",assessment.remarks],
      ["strengths","Automatically identified strengths",assessment.strengths],
      ["areasForImprovement","Automatically identified areas for improvement",assessment.areasForImprovement],
      ["recommendedIntervention","Automatically recommended interventions",assessment.recommendedIntervention]
    ].forEach(function(field){
      var wrapper=document.createElement("div");
      var label=document.createElement("label");
      var input=document.createElement("textarea");
      input.readOnly=true;
      input.setAttribute("aria-live","polite");
      input.maxLength=1000;
      input.id="rmaAssessment"+field[0];
      label.htmlFor=input.id;
      label.textContent=field[1];
      input.value=field[2]||"";
      input.defaultValue=input.value;
      wrapper.append(label,input);
      narrative.appendChild(wrapper);
    });
    rmaDirty=false;
    updateRmaAssessmentPreview();
    $("rmaAssessmentDialog").showModal();
    var focusTarget=$("rmaAssessmentDate").value
      ?itemContainer.querySelector('input[type="checkbox"],select[data-field="correctItem"]'):$("rmaAssessmentDate");
    if(focusTarget)focusTarget.focus();
  }

  function rmaAssessmentScoresFromForm(includeIncorrectItems){
    var scores={};
    $("rmaAssessmentItems").querySelectorAll('[data-field="correctItem"]').forEach(function(input){
      var originalScore=Number(input.dataset.originalScore)||0;
      if(input.type==="checkbox"&&input.checked){
        scores[input.dataset.itemKey]=Number(input.dataset.maximum);
      }else if(input.tagName==="SELECT"&&input.value!==""){
        scores[input.dataset.itemKey]=Number(input.value);
      }else if(input.dataset.touched!=="true"&&originalScore>0){
        scores[input.dataset.itemKey]=originalScore;
      }else if(includeIncorrectItems){
        scores[input.dataset.itemKey]=0;
      }
    });
    return scores;
  }

  function updateRmaAssessmentPreview(){
    if(!rmaData||!rmaEditingStudentId)return;
    var student=rmaData.students.find(function(entry){return entry.id===rmaEditingStudentId});
    if(!student)return;
    var date=$("rmaAssessmentDate").value;
    $("rmaAssessmentAge").textContent=student.birthdate
      ?"Age at assessment: "+rmaAge(student.birthdate,date):"";
    var scores=rmaAssessmentScoresFromForm(false);
    var grade=rmaData.template.grades.find(function(entry){return entry.gradeLevel===rmaGradeLevel});
    var gradeIndex=rmaData.template.grades.indexOf(grade);
    var eligible=rmaData.template.items.filter(function(item){
      return rmaData.template.grades.findIndex(function(entry){return entry.gradeLevel===item.gradeLevel})<=gradeIndex;
    });
    if(!date){
      $("rmaAssessmentPreview").textContent="Enter an assessment date to calculate the score.";
      $("rmaAssessmentDomains").querySelectorAll("[data-domain-preview] span").forEach(function(span){
        span.textContent="Data Not Yet Available";
      });
      updateRmaAssessmentNarrative(null);
      return;
    }
    var raw=eligible.reduce(function(total,item){return total+(scores[item.key]||0)},0);
    var percentage=raw/grade.maximumScore*100;
    var band=grade.masteryBands.find(function(entry){return raw>=entry.minimumRawScore})
      ||grade.masteryBands[grade.masteryBands.length-1];
    $("rmaAssessmentPreview").textContent=raw+" / "+grade.maximumScore+" points · "
      +percentage.toFixed(2)+"% · "+band.level;
    var domainResults=[];
    rmaData.template.domains.forEach(function(domain){
      var target=$("rmaAssessmentDomains").querySelector('[data-domain-preview="'+domain.key+'"] span');
      var itemKeys=domain.itemKeys[rmaGradeLevel];
      var maximum=itemKeys.reduce(function(total,key){
        return total+rmaData.template.items.find(function(item){return item.key===key}).maximum;
      },0);
      var score=itemKeys.reduce(function(total,key){return total+(scores[key]||0)},0);
      target.textContent=score+" / "+maximum+" · "+(score/maximum>=.75?"75% benchmark met":"below 75%");
      domainResults.push({
        key:domain.key,label:domain.label,category:domain.category,score:score,maximum:maximum,
        percentageScore:score/maximum*100,meetsBenchmark:score/maximum>=.75
      });
    });
    updateRmaAssessmentNarrative({
      rawScore:raw,totalItems:grade.maximumScore,percentageScore:percentage,masteryLevel:band.level,
      domainScores:domainResults.filter(function(domain){return domain.category==="Content Domain"})
    });
  }

  function updateRmaAssessmentNarrative(score){
    var fields=["remarks","strengths","areasForImprovement","recommendedIntervention"];
    var narrative=score?rmaGeneratedNarrative(score):{
      remarks:"Enter the assessment date and item results to generate this summary.",
      strengths:"Enter the assessment date and item results to identify strengths.",
      areasForImprovement:"Enter the assessment date and item results to identify areas for improvement.",
      recommendedIntervention:"Enter the assessment date and item results to generate recommendations."
    };
    fields.forEach(function(field){
      $("rmaAssessment"+field).value=narrative[field];
    });
  }

  function rmaGeneratedNarrative(score){
    var domains=score.domainScores||[];
    var meetingBenchmark=domains.filter(function(domain){return domain.meetsBenchmark});
    var belowBenchmark=domains.filter(function(domain){return !domain.meetsBenchmark})
      .sort(function(left,right){return left.percentageScore-right.percentageScore});
    var domainSummary=domains.map(function(domain){
      return domain.label+": "+domain.score+"/"+domain.maximum+" ("+domain.percentageScore.toFixed(2)+"%)";
    }).join("; ");
    var strongest=domains.slice().sort(function(left,right){return right.percentageScore-left.percentageScore})[0];
    var interventions={
      "Number and Number Sense":"Use number lines, place-value models, and guided computation practice.",
      "Geometry":"Review shape properties and spatial reasoning with diagrams and hands-on models.",
      "Measurement":"Practice selecting units and solving measurement problems with visual and real-world examples.",
      "Statistics & Probability":"Use tables, graphs, and simple experiments to practice interpreting data and probability.",
      "Algebra":"Model unknown values with patterns, expressions, and step-by-step equation practice."
    };
    return {
      remarks:score.rawScore+"/"+score.totalItems+" points ("+score.percentageScore.toFixed(2)+"%). "
        +score.masteryLevel+". "+domainSummary,
      strengths:meetingBenchmark.length?meetingBenchmark.map(function(domain){
        return domain.label+" ("+domain.percentageScore.toFixed(2)+"%)";
      }).join("; "):strongest
        ?"No content domain met the 75% benchmark. Relative strength: "+strongest.label+"."
        :"Data Not Yet Available",
      areasForImprovement:belowBenchmark.length?belowBenchmark.map(function(domain){
        return domain.label+" ("+domain.percentageScore.toFixed(2)+"%; "+domain.score+"/"+domain.maximum+")";
      }).join("; "):"All assessed content domains met or exceeded the 75% benchmark.",
      recommendedIntervention:belowBenchmark.length?belowBenchmark.map(function(domain){
        return domain.label+": "+interventions[domain.label];
      }).join(" "):"Maintain progress with mixed review and enrichment tasks across all five content domains."
    };
  }

  function hasUnsavedRmaChanges(){
    if(!$("rmaAssessmentDialog").open)return false;
    return Array.from($("rmaAssessmentForm").querySelectorAll(".rma-entry-input"))
      .some(function(input){
        if(input.tagName==="SELECT")return input.value!==input.dataset.initialValue;
        if(input.type!=="checkbox")return input.value!==input.defaultValue;
        return input.checked!==input.defaultChecked
          ||(Number(input.dataset.originalScore)>0&&input.dataset.touched==="true"&&!input.checked);
      });
  }

  async function loadRma(){
    var requestId=++rmaRequestId;
    var initialLoad=!rmaData;
    $("rmaNotice").textContent="";
    $("rmaNotice").classList.remove("error");
    $("rmaEntryCount").textContent="Loading learners...";
    try{
      var results=await Promise.all([api("/api/math-assessments"),api("/api/teacher/profile")]);
      if(requestId!==rmaRequestId)return;
      if(!Array.isArray(results[0].students)||!Array.isArray(results[0].periods)
        ||!Array.isArray(results[0].masteryBands)||!results[0].template
        ||!Array.isArray(results[0].template.grades)||!Array.isArray(results[0].template.items)
        ||!Array.isArray(results[0].template.domains)){
        throw new Error("The server returned an invalid RMA assessment report.");
      }
      rmaData=results[0];
      rmaProfile=results[1];
      if(initialLoad){
        var profileGrade=rmaData.template.grades.find(function(grade){
          return grade.gradeLevel===rmaProfile.grade;
        });
        var savedGrade=rmaData.students.map(function(student){
          return student.assessments[rmaPeriod].gradeLevel;
        }).find(function(gradeLevel){
          return rmaData.template.grades.some(function(grade){return grade.gradeLevel===gradeLevel});
        });
        rmaGradeLevel=profileGrade?profileGrade.gradeLevel:savedGrade||"Grade 5";
      }
      renderRmaReport();
      renderRmaEntry();
    }catch(error){
      if(requestId!==rmaRequestId)return;
      $("rmaEntryCount").textContent="Unable to load";
      $("rmaNotice").textContent=error.message;
      $("rmaNotice").classList.add("error");
    }
  }

  function setRmaPeriod(period){
    if(!rmaData||!rmaData.periods.includes(period)||period===rmaPeriod)return;
    if(rmaDirty&&!window.confirm("Discard unsaved RMA assessment changes?"))return;
    rmaDirty=false;
    if($("rmaAssessmentDialog").open)$("rmaAssessmentDialog").close();
    rmaEditingStudentId="";
    rmaPeriod=period;
    var savedGrade=rmaData.students.map(function(student){return student.assessments[period].gradeLevel})
      .find(function(gradeLevel){return rmaData.template.grades.some(function(grade){return grade.gradeLevel===gradeLevel})});
    if(savedGrade)rmaGradeLevel=savedGrade;
    document.querySelectorAll(".rma-period-tab").forEach(function(tab){
      tab.setAttribute("aria-selected",String(tab.dataset.period===period));
    });
    renderRmaReport();
    renderRmaEntry();
  }

  async function saveRmaAssessment(){
    if(rmaSaving)return;
    var studentId=rmaEditingStudentId;
    var student=rmaData&&rmaData.students.find(function(entry){return entry.id===studentId});
    if(!student)return;
    var fields={};
    $("rmaAssessmentForm").querySelectorAll(".rma-entry-input").forEach(function(input){
      if(input.dataset.field==="assessedDate")fields[input.dataset.field]=input.value.trim();
    });
    var itemScores=fields.assessedDate?rmaAssessmentScoresFromForm(true):{};
    var hasItemAnswers=Array.from($("rmaAssessmentItems").querySelectorAll('[data-field="correctItem"]'))
      .some(function(input){
        if(input.type==="checkbox")return input.checked
          ||(input.dataset.touched!=="true"&&Number(input.dataset.originalScore)>0);
        return input.value!==""||(input.dataset.touched!=="true"&&Number(input.dataset.originalScore)>0);
      });
    if(!fields.assessedDate&&hasItemAnswers){
      $("rmaAssessmentError").textContent="Enter the assessment date before saving item scores.";
      $("rmaAssessmentDate").focus();
      return;
    }
    var button=$("saveRmaAssessment");
    var controls=Array.from($("rmaAssessmentForm").querySelectorAll("input,textarea,button"));
    rmaSaving=true;
    controls.forEach(function(control){control.disabled=true});
    button.textContent="Saving...";
    $("rmaAssessmentError").textContent="";
    $("rmaNotice").textContent="";
    $("rmaNotice").classList.remove("error");
    var period=rmaPeriod;
    try{
      var saved=await api("/api/math-assessments",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          studentId:studentId,
          period:period,
          gradeLevel:rmaGradeLevel,
          assessedDate:fields.assessedDate,
          itemScores:itemScores
        })
      });
      var studentName=student.name;
      rmaDirty=false;
      $("rmaAssessmentDialog").close();
      rmaEditingStudentId="";
      if(rmaPeriod===period){
        await loadRma();
        $("rmaNotice").textContent=saved.removed
          ?"Empty assessment cleared.":"Template-aligned results saved for "+studentName+" ("+period+").";
      }else{
        $("rmaNotice").textContent="RMA results were saved. Reload the selected assessment cycle to view them.";
      }
    }catch(error){
      $("rmaAssessmentError").textContent=error.message;
    }finally{
      rmaSaving=false;
      controls.forEach(function(control){control.disabled=false});
      button.textContent="Save Assessment";
    }
  }

  async function downloadRma(format){
    if(rmaDirty&&!window.confirm("Unsaved RMA entries will not be included in this export. Continue with the last saved results?"))return;
    var button=format==="xlsx"?$("rmaExportXlsx"):$("rmaExportCsv");
    button.disabled=true;
    $("rmaNotice").textContent="";
    $("rmaNotice").classList.remove("error");
    try{
      var exportQuery=new URLSearchParams({period:rmaPeriod,format:format});
      if(activeStudentSection!=="__all__")exportQuery.set("section",activeStudentSection);
      var response=await fetch("/api/math-assessments/export?"+exportQuery.toString());
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to export RMA results.");
      }
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=format==="xlsx"?"RMA TEMP.xlsx":"RMA_"+rmaPeriod+"_report.csv";
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      $("rmaNotice").textContent=rmaPeriod+" RMA "+format.toUpperCase()+" export started.";
    }catch(error){
      $("rmaNotice").textContent=error.message;
      $("rmaNotice").classList.add("error");
    }finally{
      button.disabled=false;
    }
  }

  function setRmaView(view){
    if(view===rmaView)return;
    if(rmaDirty&&!window.confirm("Discard unsaved RMA assessment changes?")){
      return;
    }
    if(rmaDirty){
      rmaDirty=false;
    }
    if($("rmaAssessmentDialog").open)$("rmaAssessmentDialog").close();
    rmaEditingStudentId="";
    rmaView=view;
    $("rmaReportPanel").hidden=view!=="report";
    $("rmaEntryPanel").hidden=view!=="record";
    $("rmaReportTab").setAttribute("aria-selected",String(view==="report"));
    $("rmaRecordTab").setAttribute("aria-selected",String(view==="record"));
    if(view==="record")renderRmaEntry();
  }

  function setReadingPanel(panel){
    var periodByTab={
      readingBosyTab:"BOSY",
      readingMosyTab:"MOSY",
      readingEosyTab:"EOSY",
      readingBosyRecordTab:"BOSY",
      readingMosyRecordTab:"MOSY",
      readingEosyRecordTab:"EOSY"
    };
    var selectedPeriod=periodByTab[panel];
    var isReport=panel==="readingBosyTab"||panel==="readingMosyTab"||panel==="readingEosyTab";
    var changedPeriod=readingPeriod!==selectedPeriod;
    var leavingRecord=!$("readingRecordPanel").hidden&&isReport;
    if((changedPeriod||leavingRecord)&&readingDirty
      &&!window.confirm("Discard unsaved reading assessment changes?"))return;
    if(changedPeriod)readingDirty=false;
    ["readingBosyTab","readingMosyTab","readingEosyTab","readingBosyRecordTab","readingMosyRecordTab","readingEosyRecordTab"].forEach(function(id){
      $(id).setAttribute("aria-selected",String(id===panel));
    });
    var showRecord=!isReport;
    $(showRecord?"readingRecordPanel":"readingReportPanel").setAttribute("aria-labelledby",panel);
    $("readingReportPanel").hidden=showRecord;
    $("readingRecordPanel").hidden=!showRecord;
    readingPeriod=selectedPeriod;
    if(isReport||changedPeriod||!readingProgressData||readingProgressData.period!==readingPeriod){
      loadReadingProgress();
    }
  }
  document.querySelectorAll(".rma-period-tab").forEach(function(tab){
    tab.onclick=function(){setRmaPeriod(tab.dataset.period)};
  });
  $("rmaReportTab").onclick=function(){setRmaView("report")};
  $("rmaRecordTab").onclick=function(){setRmaView("record")};
  $("rmaEntryRows").addEventListener("click",function(event){
    var button=event.target.closest("button[data-student-id]");
    if(button)openRmaAssessment(button.dataset.studentId);
  });
  $("rmaAssessmentForm").addEventListener("submit",function(event){event.preventDefault()});
  $("rmaAssessmentForm").addEventListener("input",function(event){
    if(!event.target.matches(".rma-entry-input"))return;
    updateRmaAssessmentPreview();
    rmaDirty=hasUnsavedRmaChanges();
  });
  $("rmaAssessmentForm").addEventListener("change",function(event){
    var input=event.target;
    if(input.dataset.field==="correctItem")input.dataset.touched="true";
    updateRmaAssessmentPreview();
    rmaDirty=hasUnsavedRmaChanges();
  });
  function closeRmaAssessment(){
    if(!$("rmaAssessmentDialog").open)return;
    if(rmaSaving)return;
    if(rmaDirty&&!window.confirm("Discard unsaved RMA assessment changes?"))return;
    rmaDirty=false;
    $("rmaAssessmentDialog").close();
    rmaEditingStudentId="";
  }
  $("rmaAssessmentDialog").addEventListener("cancel",function(event){
    if(rmaSaving){
      event.preventDefault();
      return;
    }
    if(rmaDirty&&!window.confirm("Discard unsaved RMA assessment changes?")){
      event.preventDefault();
      return;
    }
    rmaDirty=false;
  });
  $("rmaAssessmentDialog").addEventListener("close",function(){rmaEditingStudentId=""});
  $("closeRmaAssessment").onclick=closeRmaAssessment;
  $("cancelRmaAssessment").onclick=closeRmaAssessment;
  $("saveRmaAssessment").onclick=saveRmaAssessment;
  $("rmaGradeSelect").onchange=function(){
    if(!rmaData){
      this.value=rmaGradeLevel;
      return;
    }
    var selectedGrade=this.value;
    if(!rmaData.template.grades.some(function(grade){return grade.gradeLevel===selectedGrade})){
      this.value=rmaGradeLevel;
      return;
    }
    if(selectedGrade===rmaGradeLevel)return;
    if(rmaDirty&&!window.confirm("Discard unsaved RMA assessment changes?")){
      this.value=rmaGradeLevel;
      return;
    }
    rmaDirty=false;
    rmaGradeLevel=selectedGrade;
    renderRmaEntry();
  };
  $("rmaLearnerSelect").onchange=renderRmaLearnerChart;
  $("rmaExportXlsx").onclick=function(){downloadRma("xlsx")};
  $("rmaExportCsv").onclick=function(){downloadRma("csv")};
  $("rmaPrint").onclick=function(){
    if(rmaDirty&&!window.confirm("Unsaved RMA entries will not be included in the printable report. Continue with saved results?"))return;
    rmaView="report";
    $("rmaReportPanel").hidden=false;
    $("rmaEntryPanel").hidden=true;
    $("rmaReportTab").setAttribute("aria-selected","true");
    $("rmaRecordTab").setAttribute("aria-selected","false");
    document.body.classList.add("rma-printing");
    window.print();
  };
  $("rmaAddStudent").onclick=function(){showDashboardPage("students")};

  $("philIriRecordTab").onclick=function(){setPhilIriTab("philIriRecordTab")};
  $("philIriClassTab").onclick=function(){setPhilIriTab("philIriClassTab")};
  $("philIriSettingsTab").onclick=function(){setPhilIriTab("philIriSettingsTab")};
  $("philIriSchoolTab").onclick=function(){setPhilIriTab("philIriSchoolTab")};
  $("philIriPeriod").onchange=function(){
    loadPhilIriReports();
    if(!$("philIriSchoolPanel").hidden)loadPhilIriSchoolReport();
  };
  $("philIriType").onchange=function(){
    loadPhilIriReports();
    if(!$("philIriSchoolPanel").hidden)loadPhilIriSchoolReport();
  };
  $("philIriLearnerSearch").oninput=renderPhilIriLearners;
  $("philIriLearner").onchange=updatePhilIriEntry;
  $("philIriLanguage").onchange=updatePhilIriEntry;
  $("philIriMode").onchange=function(){
    loadPhilIriEntry();
    updatePhilIriIndividualPreview();
  };
  $("philIriGstScore").oninput=function(){
    updatePhilIriGstPreview();
    schedulePhilIriAutosave("GST");
  };
  $("philIriGstTotal").oninput=function(){
    updatePhilIriGstPreview();
    schedulePhilIriAutosave("GST");
  };
  ["philIriDate","philIriAssessor"].forEach(function(id){
    $(id).addEventListener("input",function(){
      if($("philIriGstScore").value&&$("philIriGstTotal").value)schedulePhilIriAutosave("GST");
      if($("philIriWords").value&&$("philIriQuestions").value)schedulePhilIriAutosave("Individualized");
    });
  });
  ["philIriPassage","philIriWords","philIriMiscues","philIriSeconds","philIriCorrectAnswers","philIriQuestions",
    "philIriDifficulty","philIriIntervention","philIriInterventionStart","philIriInterventionEnd","philIriProgressNotes","philIriRemarks"]
    .forEach(function(id){
      $(id).addEventListener("input",function(){
        updatePhilIriIndividualPreview();
        schedulePhilIriAutosave("Individualized");
      });
      $(id).addEventListener("change",function(){
        updatePhilIriIndividualPreview();
        schedulePhilIriAutosave("Individualized");
      });
    });
  $("philIriSaveGst").onclick=function(){savePhilIriAssessment("GST",false)};
  $("philIriSaveIndividual").onclick=function(){savePhilIriAssessment("Individualized",false)};
  $("philIriSaveCutoffs").onclick=savePhilIriCutoffs;
  $("philIriClassSearch").oninput=schedulePhilIriClassReport;
  $("philIriGradeFilter").onchange=renderPhilIriClassReport;
  $("philIriSectionFilter").onchange=renderPhilIriClassReport;
  $("philIriLevelFilter").onchange=renderPhilIriClassReport;
  $("philIriExportClass").onclick=function(){downloadPhilIriReport("class","")};
  (function(){
    var menuButton=$("philIriDownloadReport"),menu=$("philIriDownloadOptions");
    function setMenu(open){menu.hidden=!open;menuButton.setAttribute("aria-expanded",String(open))}
    menuButton.onclick=function(event){event.stopPropagation();setMenu(menu.hidden)};
    menu.querySelectorAll("[data-philiri-form]").forEach(function(option){
      option.onclick=function(){setMenu(false);downloadPhilIriForm(option.dataset.philiriForm)};
    });
    document.addEventListener("click",function(event){
      if(!menu.hidden&&!menu.contains(event.target))setMenu(false);
    });
    document.addEventListener("keydown",function(event){
      if(event.key==="Escape"&&!menu.hidden){setMenu(false);menuButton.focus()}
    });
  })();
  $("philIriExportStudent").onclick=function(){
    var student=philIriSelectedStudent();
    if(student)downloadPhilIriReport("class",student.id);
    else{
      $("philIriRecordNotice").textContent="Select a learner before exporting an individual report.";
      $("philIriRecordNotice").classList.add("error");
    }
  };
  $("philIriExportSchool").onclick=function(){downloadPhilIriReport("school","")};
  $("philIriPrint").onclick=printPhilIriReport;
  window.addEventListener("afterprint",function(){
    document.body.classList.remove("philiri-printing","rma-printing");
    $("philIriIndividualPrint").hidden=true;
  });
  $("readingBosyTab").onclick=function(){setReadingPanel("readingBosyTab")};
  $("readingMosyTab").onclick=function(){setReadingPanel("readingMosyTab")};
  $("readingEosyTab").onclick=function(){setReadingPanel("readingEosyTab")};
  $("readingBosyRecordTab").onclick=function(){setReadingPanel("readingBosyRecordTab")};
  $("readingMosyRecordTab").onclick=function(){setReadingPanel("readingMosyRecordTab")};
  $("readingEosyRecordTab").onclick=function(){setReadingPanel("readingEosyRecordTab")};
  $("readingAttemptNumber").onchange=function(){
    var selectedAttempt=Number(this.value);
    if(!Number.isSafeInteger(selectedAttempt)||selectedAttempt<1){
      this.value=String(readingAttempt);
      $("readingNotice").textContent="Enter a whole assessment number greater than zero.";
      $("readingNotice").classList.add("error");
      return;
    }
    if(selectedAttempt===readingAttempt)return;
    if(readingDirty&&!window.confirm("Discard unsaved reading assessment changes?")){
      this.value=String(readingAttempt);
      return;
    }
    readingDirty=false;
    readingAttempt=selectedAttempt;
    loadReadingProgress();
  };
  $("readingRecordRows").onclick=async function(event){
    var button=event.target.closest("button[data-student-id]");
    if(!button)return;
    var row=button.closest("tr");
    var savedPeriod=readingPeriod;
    var savedAttempt=readingAttempt;
    var levels={};
    readingProgressData.languages.forEach(function(language,index){
      levels[language]=row.querySelectorAll("select")[index].value;
    });
    button.disabled=true;button.textContent="Saving...";
    $("readingNotice").textContent="";
    $("readingNotice").classList.remove("error");
    try{
      var saved=await api("/api/reading-assessments",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({studentId:button.dataset.studentId,period:savedPeriod,attemptNo:savedAttempt,levels:levels})
      });
      var student=readingProgressData&&readingProgressData.period===savedPeriod
        ?readingProgressData.students.find(function(entry){return entry.id===button.dataset.studentId})
        :null;
      if(student){
        readingProgressData.languages.forEach(function(language){
          student.levels[language]=levels[language];
          student.assessedDates[language]=saved.assessedDates[language];
        });
      }
      if(readingPeriod===savedPeriod&&readingAttempt===savedAttempt
        &&readingProgressData&&readingProgressData.period===savedPeriod
        &&readingProgressData.attemptNo===savedAttempt){
        renderReadingProgress(readingProgressData);
        $("readingNotice").textContent=savedPeriod+" "+formatReadingAttempt(savedAttempt)
          +" reading assessment saved. The date was recorded automatically.";
      }else{
        $("readingNotice").textContent=savedPeriod+" "+formatReadingAttempt(savedAttempt)
          +" reading assessment saved. Select that period and attempt to view the updated report.";
      }
    }catch(error){
      button.disabled=false;button.textContent="Save";
      $("readingNotice").textContent=error.message;
      $("readingNotice").classList.add("error");
    }
  };
  $("readingAddStudent").onclick=function(){showDashboardPage("students")};
  var teacherProfileSchoolFieldIds=new Set([
    "teacherProfileSchoolYear","teacherProfileFirstDayOfSchool","teacherProfileEndOfSchoolYear","teacherProfileSchoolName","teacherProfileSchoolId","teacherProfileRegion",
    "teacherProfileDivision","teacherProfileDistrict","teacherProfileSchoolHead","teacherProfileSchoolHeadPosition"
  ]);
  function updateTeacherProfileDirtyState(){
    teacherProfileDetailsDirty=teacherProfileBasicDirty||teacherProfileSchoolDirty;
    teacherProfileDirty=teacherProfileDetailsDirty||teacherSubjectsDirty;
  }
  ["teacherProfileName","teacherProfilePosition","teacherProfileEmail","teacherProfileClassroom","teacherProfileSectionsHandled","teacherProfileSchoolYear","teacherProfileFirstDayOfSchool","teacherProfileEndOfSchoolYear","teacherProfileSchoolName","teacherProfileSchoolId","teacherProfileRegion","teacherProfileDivision","teacherProfileDistrict","teacherProfileSchoolHead","teacherProfileSchoolHeadPosition"].forEach(function(id){
    $(id).addEventListener("input",function(){
      var isSchoolField=teacherProfileSchoolFieldIds.has(id);
      if(isSchoolField)teacherProfileSchoolDirty=true;
      else teacherProfileBasicDirty=true;
      updateTeacherProfileDirtyState();
      if(isSchoolField){
        $("teacherProfileSchoolError").textContent="";
        $("teacherProfileSchoolNotice").textContent="";
      }else{
        $("teacherProfileBasicError").textContent="";
        $("teacherProfileBasicNotice").textContent="";
      }
      if(id==="teacherProfileName"||id==="teacherProfilePosition"
        ||id==="teacherProfileSchoolHead"||id==="teacherProfileSchoolHeadPosition"){
        syncEnglishLessonPlanProfileFields();
      }
      if(id==="teacherProfileSectionsHandled")syncTeacherSectionRenamePasswordField();
    });
  });
  $("teacherProfileSubjectsHandled").addEventListener("change",function(){
    teacherSubjectsDirty=true;
    teacherProfileDirty=true;
    $("teacherSubjectsNotice").textContent="";
    $("teacherProfileError").textContent="";
  });
  $("teacherSubjectSection").addEventListener("change",function(){
    teacherSubjectSection=this.value;
    syncLessonPlanLearningAreas();
    syncEnglishLessonPlanProfileFields();
    renderTeacherSubjectChoices(availableSubjects,getTeacherSubjectsForSection(teacherSubjectSection));
    updateTeacherSubjectLockState();
    $("teacherSubjectsNotice").textContent="";
  });
  $("toggleTeacherSubjects").onclick=async function(){
    if(teacherSubjectsLocked){
      teacherSubjectsLocked=false;
      updateTeacherSubjectLockState();
      $("teacherSubjectsNotice").textContent="";
      var firstSubjectCheckbox=$("teacherProfileSubjectsHandled").querySelector('input[type="checkbox"]');
      if(firstSubjectCheckbox)firstSubjectCheckbox.focus();
      return;
    }
    var button=$("toggleTeacherSubjects");
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    $("teacherSubjectsNotice").textContent="";
    $("teacherProfileError").textContent="";
    try{
      var result=await api("/api/teacher/profile/subjects",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({section:teacherSubjectSection,subjectsHandled:getCheckedTeacherSubjects()})
      });
      teacherSubjectSection=result.section;
      sectionSubjects=result.sectionSubjects;
      syncLessonPlanLearningAreas();
      handledSubjects=result.subjectsHandled;
      teacherSubjectsDirty=false;
      teacherSubjectsLocked=true;
      updateTeacherProfileDirtyState();
      $("teacherSubjectSection").value=teacherSubjectSection;
      renderTeacherSubjectChoices(availableSubjects,getTeacherSubjectsForSection(teacherSubjectSection));
      updateTeacherSubjectLockState();
      $("teacherSubjectsNotice").textContent="Subjects saved and locked.";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;
      button.removeAttribute("aria-busy");
    }
  };
  ["teacherCurrentPassword","teacherNewPassword","teacherConfirmPassword"].forEach(function(id){
    $(id).addEventListener("input",function(){teacherPasswordDirty=true});
  });
  var teacherProfileTabs=Array.prototype.slice.call($("teacherProfileTabs").querySelectorAll('[role="tab"]'));
  function selectTeacherProfileTab(tab){
    teacherProfileTabs.forEach(function(profileTab){
      var selected=profileTab===tab;
      profileTab.setAttribute("aria-selected",selected?"true":"false");
      profileTab.tabIndex=selected?0:-1;
      $(profileTab.getAttribute("aria-controls")).hidden=!selected;
    });
  }
  teacherProfileTabs.forEach(function(tab){
    tab.addEventListener("click",function(){selectTeacherProfileTab(tab)});
    tab.addEventListener("keydown",function(event){
      var currentIndex=teacherProfileTabs.indexOf(tab);
      var nextIndex=currentIndex;
      if(event.key==="ArrowRight")nextIndex=(currentIndex+1)%teacherProfileTabs.length;
      else if(event.key==="ArrowLeft")nextIndex=(currentIndex+teacherProfileTabs.length-1)%teacherProfileTabs.length;
      else if(event.key==="Home")nextIndex=0;
      else if(event.key==="End")nextIndex=teacherProfileTabs.length-1;
      else return;
      event.preventDefault();
      var nextTab=teacherProfileTabs[nextIndex];
      selectTeacherProfileTab(nextTab);
      nextTab.focus();
    });
  });
  function firstInvalidTeacherProfileField(fieldIds){
    for(var index=0;index<fieldIds.length;index++){
      var field=$(fieldIds[index]);
      if(!field.checkValidity())return field;
    }
    return null;
  }
  function updateSavedTeacherProfileIdentity(result){
    teacherProfileSavedIdentity={
      name:result.name,
      email:result.email,
      classroomNumber:result.classroomNumber
    };
  }
  function getTeacherSectionChanges(nextSections){
    var removedSections=handledSections.filter(function(section){
      return !nextSections.some(function(nextSection){
        return nextSection.toLocaleLowerCase()===section.toLocaleLowerCase();
      });
    });
    var addedSections=nextSections.filter(function(section){
      return !handledSections.some(function(currentSection){
        return currentSection.toLocaleLowerCase()===section.toLocaleLowerCase();
      });
    });
    return {removed:removedSections,added:addedSections};
  }
  function getTeacherSectionRename(nextSections){
    var changes=getTeacherSectionChanges(nextSections);
    return changes.removed.length===1&&changes.added.length===1
      ?{from:changes.removed[0],to:changes.added[0]}
      :null;
  }
  function syncTeacherSectionRenamePasswordField(){
    var renamedSection=getTeacherSectionRename(splitHandledList($("teacherProfileSectionsHandled").value));
    var passwordField=$("teacherProfileSectionRenamePasswordField");
    var passwordInput=$("teacherProfileSectionRenamePassword");
    passwordField.hidden=!renamedSection;
    passwordInput.required=Boolean(renamedSection);
    if(!renamedSection)passwordInput.value="";
    return renamedSection;
  }
  async function saveTeacherBasicProfile(){
    var button=$("saveTeacherBasicProfile");
    $("teacherProfileBasicError").textContent="";
    $("teacherProfileBasicNotice").textContent="";
    var sectionsToSave=splitHandledList($("teacherProfileSectionsHandled").value);
    var sectionChanges=getTeacherSectionChanges(sectionsToSave);
    var sectionRename=syncTeacherSectionRenamePasswordField();
    if(sectionChanges.removed.length&&sectionChanges.added.length&&!sectionRename){
      $("teacherProfileBasicError").textContent="Rename one section at a time so its students and saved records can be preserved.";
      return;
    }
    var profileFieldIds=[
      "teacherProfileName","teacherProfilePosition","teacherProfileEmail",
      "teacherProfileClassroom","teacherProfileSectionsHandled"
    ];
    if(sectionRename)profileFieldIds.push("teacherProfileSectionRenamePassword");
    var invalidField=firstInvalidTeacherProfileField(profileFieldIds);
    if(invalidField){
      invalidField.reportValidity();
      return;
    }
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    button.textContent="Saving...";
    try{
      var profileData={
        name:$("teacherProfileName").value,
        position:$("teacherProfilePosition").value,
        email:$("teacherProfileEmail").value,
        classroomNumber:$("teacherProfileClassroom").value,
        sectionsHandled:sectionsToSave
      };
      if(sectionRename)profileData.currentPassword=$("teacherProfileSectionRenamePassword").value;
      var result=await api("/api/teacher/profile",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(profileData)
      });
      currentUser.name=result.name;
      currentUser.email=result.email;
      defaultStudentSection=result.section||"";
      defaultStudentGrade=result.grade||"";
      handledSections=result.sectionsHandled||[];
      sectionGrades=result.sectionGrades||{};
      sectionSubjects=result.sectionSubjects||sectionSubjects;
      handledSubjects=result.subjectsHandled||[];
      if(sectionRename){
        rosterStudents.forEach(function(student){
          if(String(student.section||"").toLocaleLowerCase()===sectionRename.from.toLocaleLowerCase()){
            student.section=sectionRename.to;
          }
        });
        if(activeStudentSection.toLocaleLowerCase()===sectionRename.from.toLocaleLowerCase()){
          activeStudentSection=sectionRename.to;
        }
        if(teacherSubjectSection.toLocaleLowerCase()===sectionRename.from.toLocaleLowerCase()){
          teacherSubjectSection=sectionRename.to;
        }
      }
      $("teacherProfileName").value=result.name;
      $("teacherProfilePosition").value=result.position||"";
      $("teacherProfileEmail").value=result.email;
      $("teacherProfileClassroom").value=result.classroomNumber;
      $("teacherProfileSection").value=result.section||"";
      $("teacherProfileSectionsHandled").value=handledSections.join(", ");
      $("teacherProfileSectionRenamePassword").value="";
      syncTeacherSectionRenamePasswordField();
      updateSavedTeacherProfileIdentity(result);
      populateTeacherSubjectSections(teacherSubjectSection||result.section);
      populateSectionControls(activeStudentSection);
      renderStudents(rosterStudents);
      $("sideName").textContent=result.name;
      $("topName").textContent=result.name;
      $("teacherProfileDisplayName").textContent=result.name;
      var initials=result.name.trim().split(/\s+/).slice(0,2).map(function(part){return part.charAt(0).toUpperCase()}).join("")||"T";
      $("teacherProfileInitials").textContent=initials;
      $("topProfileInitials").textContent=initials;
      $("classSummary").textContent=currentUser.classCode
        ?"Class code for parents: "+currentUser.classCode
        :"Manage the student records for your class.";
      syncEnglishLessonPlanProfileFields();
      teacherProfileBasicDirty=false;
      updateTeacherProfileDirtyState();
      $("teacherProfileBasicNotice").textContent="Basic Info saved successfully.";
    }catch(error){
      $("teacherProfileBasicError").textContent=error.message;
    }finally{
      button.disabled=false;
      button.removeAttribute("aria-busy");
      button.textContent="Save Basic Info";
    }
  }
  async function saveTeacherSchoolProfile(){
    var button=$("saveTeacherSchoolProfile");
    $("teacherProfileSchoolError").textContent="";
    $("teacherProfileSchoolNotice").textContent="";
    var invalidField=firstInvalidTeacherProfileField([
      "teacherProfileSchoolYear","teacherProfileFirstDayOfSchool","teacherProfileEndOfSchoolYear","teacherProfileSchoolName","teacherProfileSchoolId",
      "teacherProfileRegion","teacherProfileDivision","teacherProfileDistrict",
      "teacherProfileSchoolHead","teacherProfileSchoolHeadPosition"
    ]);
    if(invalidField){
      invalidField.reportValidity();
      return;
    }
    if(!teacherProfileSavedIdentity.name||!teacherProfileSavedIdentity.email||!teacherProfileSavedIdentity.classroomNumber){
      $("teacherProfileSchoolError").textContent="Save Basic Info or reload your profile before saving School Info.";
      return;
    }
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    button.textContent="Saving...";
    try{
      var result=await api("/api/teacher/profile",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          name:teacherProfileSavedIdentity.name,
          email:teacherProfileSavedIdentity.email,
          classroomNumber:teacherProfileSavedIdentity.classroomNumber,
          schoolYear:$("teacherProfileSchoolYear").value,
          firstDayOfSchool:$("teacherProfileFirstDayOfSchool").value,
          endOfSchoolYear:$("teacherProfileEndOfSchoolYear").value,
          schoolName:$("teacherProfileSchoolName").value,
          schoolId:$("teacherProfileSchoolId").value,
          region:$("teacherProfileRegion").value,
          division:$("teacherProfileDivision").value,
          district:$("teacherProfileDistrict").value,
          schoolHead:$("teacherProfileSchoolHead").value,
          schoolHeadPosition:$("teacherProfileSchoolHeadPosition").value
        })
      });
      updateSavedTeacherProfileIdentity(result);
      $("teacherProfileSchoolYear").value=result.schoolYear||"";
      $("teacherProfileFirstDayOfSchool").value=result.firstDayOfSchool||"";
      $("teacherProfileEndOfSchoolYear").value=result.endOfSchoolYear||"";
      refreshAttendanceYears();
      $("teacherProfileSchoolName").value=result.schoolName||"";
      $("teacherProfileSchoolId").value=result.schoolId||"";
      $("teacherProfileRegion").value=result.region||"";
      $("teacherProfileDivision").value=result.division||"";
      $("teacherProfileDistrict").value=result.district||"";
      $("teacherProfileSchoolHead").value=result.schoolHead||"";
      $("teacherProfileSchoolHeadPosition").value=result.schoolHeadPosition||"";
      syncEnglishLessonPlanProfileFields();
      teacherProfileSchoolDirty=false;
      updateTeacherProfileDirtyState();
      $("teacherProfileSchoolNotice").textContent="School Info saved successfully.";
      if(!$("attendancePage").hidden)await loadAttendance();
    }catch(error){
      $("teacherProfileSchoolError").textContent=error.message;
    }finally{
      button.disabled=false;
      button.removeAttribute("aria-busy");
      button.textContent="Save School Info";
    }
  }
  $("saveTeacherBasicProfile").addEventListener("click",saveTeacherBasicProfile);
  $("saveTeacherSchoolProfile").addEventListener("click",saveTeacherSchoolProfile);
  $("teacherProfileForm").addEventListener("submit",function(event){event.preventDefault()});
  async function uploadTeacherPhoto(file){
    if(!file)return;
    $("teacherProfileError").textContent="";
    $("teacherProfileNotice").textContent="";
    if(file.size>2*1024*1024||!["image/jpeg","image/png","image/webp"].includes(file.type)){
      $("teacherProfileError").textContent="Choose a JPEG, PNG, or WebP image no larger than 2 MB.";
      $("teacherProfilePhotoFile").value="";
      return;
    }
    var button=$("chooseTeacherPhoto");
    button.disabled=true;button.textContent="Uploading...";
    try{
      await api("/api/teacher/profile/photo",{
        method:"PUT",
        headers:{"Content-Type":file.type},
        body:file
      });
      setTeacherProfilePhoto(true);
      $("teacherProfileNotice").textContent="Profile picture updated.";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;button.textContent="Add / Change Picture";
      $("teacherProfilePhotoFile").value="";
    }
  }
  $("chooseTeacherPhoto").onclick=async function(){
    if(window.gradePortal&&typeof window.gradePortal.chooseTeacherPhoto==="function"){
      var button=$("chooseTeacherPhoto");
      button.disabled=true;button.textContent="Choosing...";
      try{
        var selection=await window.gradePortal.chooseTeacherPhoto();
        if(selection.canceled)return;
        var binary=window.atob(selection.base64);
        var bytes=new Uint8Array(binary.length);
        for(var index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
        await uploadTeacherPhoto(new Blob([bytes],{type:selection.contentType}));
      }catch(error){
        $("teacherProfileError").textContent=error.message;
      }finally{
        button.disabled=false;button.textContent="Add / Change Picture";
      }
      return;
    }
    $("teacherProfilePhotoFile").click();
  };
  $("teacherProfilePhotoFile").onchange=async function(){
    await uploadTeacherPhoto(this.files&&this.files[0]);
  };
  $("removeTeacherPhoto").onclick=async function(){
    var button=this;
    button.disabled=true;
    try{
      await api("/api/teacher/profile/photo",{method:"DELETE"});
      setTeacherProfilePhoto(false);
      $("teacherProfileNotice").textContent="Profile picture removed.";
      $("teacherProfileError").textContent="";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;
    }
  };
  $("chooseSchoolLogo").onclick=function(){$("teacherSchoolLogoFile").click()};
  $("teacherSchoolLogoFile").onchange=async function(){
    var file=this.files&&this.files[0];
    if(!file)return;
    $("teacherProfileError").textContent="";
    $("teacherProfileNotice").textContent="";
    if(file.size>2*1024*1024||!["image/jpeg","image/png","image/webp"].includes(file.type)){
      $("teacherProfileError").textContent="Choose a JPEG, PNG, or WebP school logo no larger than 2 MB.";
      this.value="";
      return;
    }
    var button=$("chooseSchoolLogo");
    button.disabled=true;button.textContent="Uploading...";
    try{
      await api("/api/teacher/profile/school-logo",{
        method:"PUT",
        headers:{"Content-Type":file.type},
        body:file
      });
      setTeacherSchoolLogo(true);
      $("teacherProfileNotice").textContent="School logo updated.";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;button.textContent="Upload / Change Logo";
      this.value="";
    }
  };
  $("removeSchoolLogo").onclick=async function(){
    var button=this;
    button.disabled=true;
    try{
      await api("/api/teacher/profile/school-logo",{method:"DELETE"});
      setTeacherSchoolLogo(false);
      $("teacherProfileNotice").textContent="School logo removed.";
      $("teacherProfileError").textContent="";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;
    }
  };
  $("teacherPasswordForm").onsubmit=async function(event){
    event.preventDefault();
    $("teacherProfileError").textContent="";
    $("teacherProfileNotice").textContent="";
    var newPassword=$("teacherNewPassword").value;
    if(newPassword!==$("teacherConfirmPassword").value){
      $("teacherProfileError").textContent="The new passwords do not match.";
      return;
    }
    var button=$("saveTeacherPassword");
    button.disabled=true;button.textContent="Updating...";
    try{
      await api("/api/teacher/profile/password",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          currentPassword:$("teacherCurrentPassword").value,
          newPassword:newPassword
        })
      });
      await updateRememberedPassword(newPassword);
      $("teacherPasswordForm").reset();
      teacherPasswordDirty=false;
      $("teacherProfileNotice").textContent="Password updated.";
    }catch(error){
      $("teacherProfileError").textContent=error.message;
    }finally{
      button.disabled=false;button.textContent="Update Password";
    }
  };
  $("aboutTermsDialog").addEventListener("cancel",function(event){event.preventDefault()});
  $("aboutTermsAccept").onclick=function(){
    if(!currentUser)return;
    try{
      window.localStorage.setItem("gradePortalAboutAccepted:"+currentUser.id,"yes");
    }catch(error){
      $("aboutTermsError").textContent="Your agreement could not be saved. Enable browser storage and try again.";
      return;
    }
    $("aboutTermsDialog").close();
  };
  $("aboutTermsSignOut").onclick=async function(){
    $("aboutTermsDialog").close();
    await signOut();
  };
  $("forcedPasswordDialog").addEventListener("cancel",function(event){event.preventDefault()});
  $("forcedPasswordDialog").addEventListener("close",function(){
    if(currentUser&&currentUser.mustChangePassword)$("forcedPasswordDialog").showModal();
  });
  $("forcedPasswordForm").onsubmit=async function(event){
    event.preventDefault();
    $("forcedPasswordError").textContent="";
    var newPassword=$("forcedNewPassword").value;
    if(newPassword!==$("forcedConfirmPassword").value){
      $("forcedPasswordError").textContent="The new passwords do not match.";
      return;
    }
    var button=$("saveForcedPassword");
    button.disabled=true;button.textContent="Changing...";
    try{
      await api("/api/auth/change-password",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          currentPassword:$("forcedCurrentPassword").value,
          newPassword:newPassword
        })
      });
      await updateRememberedPassword(newPassword);
      $("forcedPasswordForm").reset();
      currentUser.mustChangePassword=false;
      $("forcedPasswordDialog").close();
      await enter(currentUser);
    }catch(error){
      $("forcedPasswordError").textContent=error.message;
    }finally{
      button.disabled=false;button.textContent="Change password";
    }
  };
  $("gradeSummaryTerm").onchange=renderGradeSummary;
  $("exportGradeSummary").onclick=exportGradeSummary;
  allGradeFields.forEach(function(field){
    $("grade"+field[0][0].toUpperCase()+field[0].slice(1)).addEventListener("input",function(){
      gradesDirty=true;
      updateMapehAverage();
      updateGradeEditorState();
    });
  });
  $("gradeStudent").onchange=function(){
    if(gradesDirty&&!window.confirm("Discard unsaved grade changes and load another student?")){
      this.value=activeGradeSelection.studentId;
      return;
    }
    loadGradeRecord();
  };
  $("gradeTeacherComment").addEventListener("input",function(){
    gradesDirty=true;
    $("gradeCommentSuggestionStatus").textContent="";
    $("gradeCommentSuggestionStatus").classList.remove("error");
    updateTeacherCommentCount();
    updateGradeEditorState();
  });
  $("gradeCommentSuggestion").addEventListener("change",function(){
    $("addGradeCommentSuggestion").disabled=!this.value;
    $("gradeCommentSuggestionStatus").textContent="";
    $("gradeCommentSuggestionStatus").classList.remove("error");
  });
  $("addGradeCommentSuggestion").addEventListener("click",function(){
    var suggestion=$("gradeCommentSuggestion").value;
    var commentField=$("gradeTeacherComment");
    var current=commentField.value;
    var separator=current?(current.endsWith("\n")?(current.endsWith("\n\n")?"":"\n"):"\n\n"):"";
    var status=$("gradeCommentSuggestionStatus");
    status.textContent="";
    status.classList.remove("error");
    if(!suggestion)return;
    if(current.length+separator.length+suggestion.length>commentField.maxLength){
      status.textContent="This suggestion would exceed 1,000 characters. Shorten the comment before adding it.";
      status.classList.add("error");
      return;
    }
    commentField.value=current+separator+suggestion;
    $("gradeCommentSuggestion").value="";
    $("addGradeCommentSuggestion").disabled=true;
    commentField.dispatchEvent(new Event("input",{bubbles:true}));
    status.textContent="Suggestion added. You can edit the comment before saving.";
  });
  $("gradeTerm").onchange=function(){
    if(gradesDirty&&!window.confirm("Discard unsaved grade changes and load another term?")){
      this.value=activeGradeSelection.term;
      return;
    }
    loadGradeRecord();
  };
  $("editGrades").onclick=async function(){
    if(gradeEditUpdating||!gradeRecordAvailable)return;
    if(!activeTermLocked){
      if(gradesDirty&&!window.confirm("Discard unsaved changes for "+selectedGradeStudentName()+" and lock "+$("gradeTerm").value+" grades for every student?"))return;
      gradeEditUpdating=true;
      $("gradeNotice").textContent="";
      $("gradeNotice").classList.remove("error");
      updateGradeEditorState();
      try{
        var lockResult=await api("/api/grades/term-lock",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({term:$("gradeTerm").value,locked:true})
        });
        gradesDirty=false;
        await loadGradeRecord();
        $("gradeNotice").textContent=lockResult.term+" grades are locked for all "+lockResult.studentCount
          +" student"+(lockResult.studentCount===1?"":"s")+".";
      }catch(error){
        $("gradeNotice").textContent=error.message;
        $("gradeNotice").classList.add("error");
      }finally{
        gradeEditUpdating=false;
        updateGradeEditorState();
      }
      return;
    }
    $("gradeUnlockDescription").textContent="Enter your current teacher password once to unlock "
      +$("gradeTerm").value+" grade entry for all "+gradeStudents.length+" students in this class.";
    $("gradeUnlockError").textContent="";
    $("gradeUnlockForm").reset();
    $("gradeUnlockDialog").showModal();
    $("gradeUnlockPassword").focus();
  };
  $("closeGradeUnlockDialog").onclick=function(){$("gradeUnlockDialog").close()};
  $("cancelGradeUnlock").onclick=function(){$("gradeUnlockDialog").close()};
  $("gradeUnlockDialog").addEventListener("close",function(){
    $("gradeUnlockForm").reset();
    $("gradeUnlockError").textContent="";
  });
  $("gradeUnlockForm").onsubmit=async function(event){
    event.preventDefault();
    if(gradeEditUpdating||!gradeRecordAvailable||!activeTermLocked)return;
    gradeEditUpdating=true;
    $("gradeNotice").textContent="";
    $("gradeNotice").classList.remove("error");
    updateGradeEditorState();
    var button=$("confirmGradeUnlock");
    button.disabled=true;
    button.textContent="Verifying...";
    try{
      var result=await api("/api/grades/term-lock",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          term:$("gradeTerm").value,
          locked:false,
          password:$("gradeUnlockPassword").value
        })
      });
      $("gradeNotice").textContent=result.term+" grades are unlocked for all "+result.studentCount
        +" student"+(result.studentCount===1?"":"s")+".";
      $("gradeUnlockDialog").close();
      await loadGradeRecord();
    }catch(error){
      $("gradeUnlockError").textContent=error.message;
      $("gradeUnlockPassword").focus();
    }finally{
      gradeEditUpdating=false;
      button.disabled=false;
      button.textContent="Unlock grades";
      updateGradeEditorState();
    }
  };
  $("gradeForm").onsubmit=async function(event){
    event.preventDefault();
    if(activeTermLocked||!gradeRecordAvailable||gradeSaving)return;
    $("gradeNotice").textContent="";
    $("gradeNotice").classList.remove("error");
    var grades={};
    gradeFields.forEach(function(field){
      grades[field[0]]=$("grade"+field[0][0].toUpperCase()+field[0].slice(1)).value;
    });
    var button=$("saveGrades");
    gradeSaving=true;
    updateGradeEditorState();
    button.textContent="Saving...";
    try{
      var result=await api("/api/grades",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          studentId:$("gradeStudent").value,
          term:$("gradeTerm").value,
          grades:grades,
          teacherComment:$("gradeTeacherComment").value
        })
      });
      gradesDirty=false;
      updateGradeLockDisplay(result.locked);
      $("gradeNotice").textContent="Grades and teacher's comment saved for "+selectedGradeStudentName()+". "+$("gradeTerm").value
        +" remains unlocked for all students until you select Lock Term.";
    }catch(error){
      if(error.status===409)updateGradeLockDisplay(true);
      $("gradeNotice").textContent=error.message;
      $("gradeNotice").classList.add("error");
    }finally{
      gradeSaving=false;
      button.textContent="Save Grades";
      updateGradeEditorState();
    }
  };
  $("printSF9").onclick=function(){
    var studentId=$("gradeStudent").value;
    if(!studentId||!gradeRecordAvailable||gradeSaving||gradesDirty)return;
    var previewUrl="/api/grades/sf9?studentId="+encodeURIComponent(studentId)+"&format=preview";
    var previewWindow=window.open(previewUrl,"_blank");
    if(!previewWindow){
      window.location.assign(previewUrl);
      return;
    }
    previewWindow.opener=null;
    $("gradeNotice").textContent="Opening the SF9 print preview for "+selectedGradeStudentName()+".";
    $("gradeNotice").classList.remove("error");
  };
  $("downloadSF9").onclick=async function(){
    var studentId=$("gradeStudent").value;
    if(!studentId||!gradeRecordAvailable||gradeSaving||gradesDirty)return;
    var button=this;
    button.disabled=true;
    button.setAttribute("aria-busy","true");
    $("gradeNotice").classList.remove("error");
    $("gradeNotice").textContent="Preparing the SF9 workbook for "+selectedGradeStudentName()+"...";
    try{
      var response=await fetch("/api/grades/sf9?studentId="+encodeURIComponent(studentId));
      if(!response.ok){
        var errorResult=await response.json();
        throw new Error(errorResult.error||"Unable to download the SF9 workbook.");
      }
      var disposition=response.headers.get("content-disposition")||"";
      var filenameMatch=disposition.match(/filename="([^"]+)"/i);
      if(!filenameMatch||!/\.xlsx$/i.test(filenameMatch[1])){
        throw new Error("The server did not provide an SF9 Excel workbook filename.");
      }
      var contentType=response.headers.get("content-type")||"";
      if(!/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet(?:;|$)/i.test(contentType)){
        throw new Error("The server response is not an SF9 Excel workbook.");
      }
      var objectUrl=URL.createObjectURL(await response.blob());
      var link=document.createElement("a");
      link.href=objectUrl;
      link.download=filenameMatch[1];
      link.style.display="none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function(){URL.revokeObjectURL(objectUrl)},1000);
      $("gradeNotice").textContent="SF9 workbook downloaded for "+selectedGradeStudentName()+".";
    }catch(error){
      $("gradeNotice").textContent="Could not download the SF9 workbook: "+error.message;
      $("gradeNotice").classList.add("error");
    }finally{
      button.removeAttribute("aria-busy");
      updateGradeEditorState();
    }
  };
  $("addStudent").onclick=openStudentDialog;
  $("studentSectionFilter").onchange=function(){
    pendingStudentSection=this.value;
    updateClearStudentRosterButton(rosterStudents);
  };
  $("selectStudentSection").onclick=function(){
    var filter=$("studentSectionFilter");
    if(!studentSectionLocked&&!pendingStudentSection)return;
    if(studentSectionLocked){
      studentSectionLocked=false;
      pendingStudentSection=activeStudentSection;
      filter.value=pendingStudentSection;
    }else{
      activeStudentSection=pendingStudentSection;
      studentSectionLocked=true;
      filter.value=activeStudentSection;
      renderStudents(rosterStudents);
    }
    updateSectionSelectionControls();
  };
  $("addNewSection").onclick=function(){
    $("newSectionError").textContent="";
    $("newSectionForm").reset();
    $("sf1FileName").textContent="When you press Add Section, the portal uses the Grade Level and Section from the SF1 file and imports its students. Enter fallback values above only if those details are missing.";
    $("newSectionDialog").showModal();
    $("newSectionName").focus();
  };
  $("closeNewSectionDialog").onclick=function(){$("newSectionDialog").close()};
  $("cancelNewSection").onclick=function(){$("newSectionDialog").close()};
  $("newSectionDialog").addEventListener("click",function(event){
    if(event.target===$("newSectionDialog"))$("newSectionDialog").close();
  });
  $("newSectionForm").onsubmit=async function(event){
    event.preventDefault();
    $("newSectionError").textContent="";
    var button=$("saveNewSection");
    var importButton=$("importSF1");
    var file=$("sf1File").files&&$("sf1File").files[0];
    var sectionName=$("newSectionName").value.trim();
    var grade=$("newSectionGrade").value.trim();
    button.disabled=true;
    button.textContent="Adding...";
    importButton.disabled=true;
    try{
      var sf1ProfileParams=new URLSearchParams({
        sectionName:sectionName,
        grade:grade,
        schoolYear:$("teacherProfileSchoolYear").value,
        schoolName:$("teacherProfileSchoolName").value,
        schoolId:$("teacherProfileSchoolId").value,
        region:$("teacherProfileRegion").value,
        division:$("teacherProfileDivision").value,
        district:$("teacherProfileDistrict").value
      });
      var result=file
        ?await api("/api/teacher/sections/import?"+sf1ProfileParams.toString(),{
          method:"POST",
          headers:{"Content-Type":"application/octet-stream"},
          body:file
        })
        :await api("/api/teacher/sections",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({sectionName:sectionName,grade:grade})
        });
      sectionName=result.sectionName||sectionName;
      grade=result.grade||grade;
      if(result.profile){
        ["schoolYear","schoolName","schoolId","region","division","district"].forEach(function(key){
          var inputId={
            schoolYear:"teacherProfileSchoolYear",
            schoolName:"teacherProfileSchoolName",
            schoolId:"teacherProfileSchoolId",
            region:"teacherProfileRegion",
            division:"teacherProfileDivision",
            district:"teacherProfileDistrict"
          }[key];
          if(!$(inputId).value.trim())$(inputId).value=result.profile[key]||"";
        });
      }
      var profileWasDirty=teacherProfileDirty;
      handledSections=result.sectionsHandled;
      sectionGrades=result.sectionGrades;
      activeStudentSection=sectionName;
      pendingStudentSection=sectionName;
      studentSectionLocked=true;
      if(profileWasDirty){
        var editedSections=splitHandledList($("teacherProfileSectionsHandled").value);
        if(!editedSections.some(function(section){return section.toLowerCase()===sectionName.toLowerCase()})){
          editedSections.push(sectionName);
        }
        $("teacherProfileSectionsHandled").value=editedSections.join(", ");
      }else{
        $("teacherProfileSectionsHandled").value=handledSections.join(", ");
      }
      populateTeacherSubjectSections(teacherSubjectSection);
      teacherProfileDirty=profileWasDirty;
      populateSectionControls(sectionName);
      if(file)await loadStudents();
      else renderStudents(rosterStudents);
      var notice=$("studentNotice");
      notice.textContent=file
        ?'Added section "'+sectionName+'" for '+grade+' and imported '+result.imported+" student"+(result.imported===1?"":"s")+" from "+file.name+"."
        :'Section "'+sectionName+'" for '+grade+" added.";
      if(file&&result.skipped.length){
        var report=document.createElement("details");
        var summary=document.createElement("summary");
        summary.textContent=result.skipped.length+" row"+(result.skipped.length===1?"":"s")+" skipped";
        var list=document.createElement("ul");
        result.skipped.forEach(function(issue){
          var item=document.createElement("li");
          item.textContent="Row "+issue.row+": "+issue.reason;
          list.appendChild(item);
        });
        report.appendChild(summary);
        report.appendChild(list);
        notice.appendChild(report);
      }
      $("studentNotice").classList.remove("error");
      $("newSectionDialog").close();
      $("newSectionForm").reset();
    }catch(error){
      $("newSectionError").textContent=error.message;
    }finally{
      button.disabled=false;
      button.textContent="Add Section";
      importButton.disabled=false;
    }
  };
  $("importSF1").onclick=function(){$("sf1File").click()};
  $("sf1File").onchange=function(){
    var file=this.files&&this.files[0];
    $("sf1FileName").textContent=file
      ?"Selected: "+file.name+". Press Add Section to read its section and grade, save them, and import the students."
      :"When you press Add Section, the portal uses the Grade Level and Section from the SF1 file and imports its students. Enter fallback values above only if those details are missing.";
  };
  function resetClearRosterDialog(){
    $("clearRosterPasswordForm").hidden=false;
    $("confirmClearRosterForm").hidden=true;
    $("clearRosterPasswordForm").reset();
    $("clearRosterPasswordError").textContent="";
    $("confirmClearRosterError").textContent="";
    $("clearRosterConfirmationText").textContent="";
    $("verifyClearRosterPassword").disabled=false;
    $("verifyClearRosterPassword").textContent="Continue";
    $("confirmClearRoster").disabled=false;
    $("confirmClearRoster").textContent="Delete selected students";
  }
  $("clearStudentRoster").onclick=function(){
    clearRosterSection=$("studentSectionFilter").value;
    clearRosterStudentCount=filterStudentsForActiveSection(rosterStudents,clearRosterSection).length;
    if(!clearRosterSection||!clearRosterStudentCount)return;
    resetClearRosterDialog();
    var sectionLabel=studentSectionFilterLabel(clearRosterSection);
    $("clearRosterScopeDescription").textContent="This will permanently remove students in "+sectionLabel+" and their class records.";
    $("confirmClearRoster").textContent="Delete "+sectionLabel+" roster";
    $("clearRosterDialog").showModal();
    $("clearRosterPassword").focus();
  };
  $("closeClearRosterDialog").onclick=function(){$("clearRosterDialog").close()};
  $("cancelClearRosterPassword").onclick=function(){$("clearRosterDialog").close()};
  $("cancelConfirmedClearRoster").onclick=function(){$("clearRosterDialog").close()};
  $("clearRosterDialog").addEventListener("close",resetClearRosterDialog);
  $("clearRosterPasswordForm").onsubmit=async function(event){
    event.preventDefault();
    var button=$("verifyClearRosterPassword");
    button.disabled=true;
    button.textContent="Checking...";
    $("clearRosterPasswordError").textContent="";
    try{
      await api("/api/students/clear/verify",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({password:$("clearRosterPassword").value})
      });
      var scopeText="from "+studentSectionFilterLabel(clearRosterSection);
      $("clearRosterConfirmationText").textContent="Confirm deletion of "+clearRosterStudentCount+" student"+(clearRosterStudentCount===1?"":"s")+" "+scopeText+".";
      $("clearRosterPasswordForm").hidden=true;
      $("confirmClearRosterForm").hidden=false;
      $("confirmClearRoster").focus();
    }catch(error){
      $("clearRosterPasswordError").textContent=error.message;
      button.disabled=false;
      button.textContent="Continue";
      $("clearRosterPassword").focus();
    }
  };
  $("confirmClearRosterForm").onsubmit=async function(event){
    event.preventDefault();
    var button=$("confirmClearRoster");
    button.disabled=true;
    button.textContent="Deleting...";
    $("confirmClearRosterError").textContent="";
    try{
      var result=await api("/api/students/clear",{
        method:"DELETE",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({password:$("clearRosterPassword").value,confirmed:true,section:clearRosterSection})
      });
      $("clearRosterDialog").close();
      if(Array.isArray(result.sectionsHandled)){
        handledSections=result.sectionsHandled;
        sectionGrades=result.sectionGrades||{};
        sectionSubjects=result.sectionSubjects||{};
        defaultStudentSection=result.primarySection||"";
        $("teacherProfileSectionsHandled").value=handledSections.join(", ");
        populateTeacherSubjectSections(teacherSubjectSection||defaultStudentSection);
      }
      await loadStudents();
      $("studentNotice").classList.remove("error");
      var scopeNotice=" from "+studentSectionFilterLabel(clearRosterSection);
      $("studentNotice").textContent="Cleared "+result.deleted+" student"+(result.deleted===1?"":"s")+scopeNotice+" and their class records."
        +(result.removedSection?" The empty section was removed from the class section list.":"");
    }catch(error){
      $("confirmClearRosterError").textContent=error.message;
      button.disabled=false;
      button.textContent="Delete "+studentSectionFilterLabel(clearRosterSection)+" roster";
    }
  };
  $("emptyAddStudent").onclick=openStudentDialog;
  var deleteStudentTarget=null;
  function openDeleteStudentDialog(student){
    deleteStudentTarget=student;
    $("deleteStudentDescription").textContent="Permanently remove "+[student.lastName,student.firstName].filter(Boolean).join(", ")+" ("+student.enrollmentStatus+") from the class list.";
    $("deleteStudentPassword").value="";
    $("deleteStudentError").textContent="";
    $("confirmDeleteStudent").disabled=false;
    $("deleteStudentDialog").showModal();
    $("deleteStudentPassword").focus();
  }
  $("closeDeleteStudentDialog").onclick=function(){$("deleteStudentDialog").close()};
  $("cancelDeleteStudent").onclick=function(){$("deleteStudentDialog").close()};
  $("deleteStudentForm").onsubmit=async function(event){
    event.preventDefault();
    if(!deleteStudentTarget)return;
    var button=$("confirmDeleteStudent");
    button.disabled=true;
    $("deleteStudentError").textContent="";
    try{
      await api("/api/students/"+encodeURIComponent(deleteStudentTarget.id),{
        method:"DELETE",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({password:$("deleteStudentPassword").value,confirmed:true})
      });
      $("deleteStudentDialog").close();
      await loadStudents();
      $("studentNotice").classList.remove("error");
      $("studentNotice").textContent="Student deleted permanently.";
    }catch(error){
      $("deleteStudentError").textContent=error.message;
      button.disabled=false;
      $("deleteStudentPassword").focus();
    }
  };
  $("closeStudentDialog").onclick=function(){$("studentDialog").close()};
  $("cancelStudent").onclick=function(){$("studentDialog").close()};
  $("studentDialog").addEventListener("click",function(event){
    if(event.target===$("studentDialog"))$("studentDialog").close();
  });
  $("studentForm").onsubmit=async function(event){
    event.preventDefault();
    $("studentFormError").textContent="";
    var data={};
    studentFields.forEach(function(field){
      var input=$("student"+field[0][0].toUpperCase()+field[0].slice(1));
      data[field[0]]=input.value.trim();
    });
    data.section=$("studentSection").value;
    var save=$("saveStudent");
    save.disabled=true;save.textContent="Saving...";
    try{
      await api("/api/students",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(data)
      });
      $("studentDialog").close();
      $("studentForm").reset();
      $("teacherPasswordForm").reset();
      $("studentNotice").classList.remove("error");
      $("studentNotice").textContent="Student saved to the workbook.";
      await loadStudents();
    }catch(error){
      $("studentFormError").textContent=error.message;
    }finally{
      save.disabled=false;save.textContent="Save Student";
    }
  };

  async function signOut(){
    if((readingDirty||rmaDirty||attendanceDirty||teacherProfileDirty||teacherPasswordDirty)
      &&!window.confirm("Discard unsaved changes?"))return;
    try{
      if(typeof window.flushEClassDraftSave==="function")await window.flushEClassDraftSave();
    }catch(error){
      console.error("Could not flush the E-Class draft before sign out:",error);
    }
    var desktopBridge=window.gradePortal;
    var logoutError=null;
    try{await api("/api/auth/logout",{method:"POST"})}catch(error){logoutError=error;console.error("Sign out failed:",error)}
    var sessionCleared=!logoutError;
    var cookieClearError=null;
    if(desktopBridge&&typeof desktopBridge.clearPortalAuthCookies==="function"){
      try{
        await desktopBridge.clearPortalAuthCookies();
        sessionCleared=true;
      }catch(error){
        cookieClearError=error;
        console.error("Could not clear the portal session cookie:",error);
      }
    }
    if(!sessionCleared){
      var signOutErrorMessage="Could not safely finish signing out. Check that the portal is running and try again.";
      $("msg").textContent=signOutErrorMessage;
      window.alert(signOutErrorMessage);
      return;
    }
    readingDirty=false;
    rmaDirty=false;
    attendanceDirty=false;
    teacherProfileDirty=false;
    teacherProfileDetailsDirty=false;
    teacherProfileBasicDirty=false;
    teacherProfileSchoolDirty=false;
    teacherProfileSavedIdentity={name:"",email:"",classroomNumber:""};
    teacherSubjectsDirty=false;
    teacherPasswordDirty=false;
    window.dispatchEvent(new Event("lessonPlanSourcesClear"));
    currentUser=null;
    if(window.stopTeacherCalendarDeadlineNotifications)window.stopTeacherCalendarDeadlineNotifications();
    document.body.classList.remove("portal-active");
    $("portal").hidden=true;
    $("authCard").hidden=false;
    $("studentForm").reset();
    $("form").reset();
    mode="in";closeSidebar();render();
    try{
      await prefillRememberedAccount();
    }catch(error){
      console.error("Could not prefill the saved sign-in after sign out:",error);
      $("msg").textContent="Signed out. Enter your account details to sign in again.";
    }
    if(logoutError){
      $("msg").textContent="Signed out on this device, but the server could not confirm the logout.";
    }else if(cookieClearError){
      $("msg").textContent="Signed out. The server session was closed, but the local session cookie could not be cleared.";
    }
  }
  document.querySelectorAll("[data-logout]").forEach(function(button){button.onclick=signOut});
  $("studentBirthdate").max=localISODate();
  function refreshAttendanceYears(){
    var yearSelect=$("attendanceYear");
    var monthSelect=$("attendanceMonth");
    var range=attendanceSchoolYearRange();
    if(!range){
      yearSelect.replaceChildren();
      yearSelect.disabled=true;
      monthSelect.disabled=true;
      $("attendancePrevMonth").disabled=true;
      $("attendanceNextMonth").disabled=true;
      $("attendanceToday").disabled=true;
      return;
    }
    var startYear=Number(range.startDate.slice(0,4));
    var endYear=Number(range.endDate.slice(0,4));
    var selectedYear=Number(yearSelect.value);
    var selectedMonth=Number(monthSelect.value);
    yearSelect.replaceChildren();
    for(var year=startYear;year<=endYear;year++)yearSelect.add(new Option(String(year),String(year)));
    var now=new Date();
    var currentMonth=now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0");
    var selected=String(selectedYear).padStart(4,"0")+"-"+String(selectedMonth).padStart(2,"0");
    if(!isAttendanceMonthAllowed(selected,range)){
      if(selectedYear>=startYear&&selectedYear<=endYear){
        selected=selectedYear===startYear
          ?range.startDate.slice(0,7)
          :selectedYear===endYear?range.endDate.slice(0,7):String(selectedYear)+"-01";
      }else{
        selected=isAttendanceMonthAllowed(currentMonth,range)?currentMonth:range.startDate.slice(0,7);
      }
    }
    yearSelect.value=selected.slice(0,4);
    Array.from(monthSelect.options).forEach(function(option){
      var month=yearSelect.value+"-"+String(Number(option.value)).padStart(2,"0");
      option.disabled=!isAttendanceMonthAllowed(month,range);
    });
    monthSelect.value=String(Number(selected.slice(5,7)));
    yearSelect.disabled=false;
    monthSelect.disabled=false;
    updateAttendanceNav();
  }
  [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December"
  ].forEach(function(month,index){
    $("attendanceMonth").add(new Option(month,String(index+1)));
  });
  var currentYear=new Date().getFullYear();
  refreshAttendanceYears();
  $("attendanceMonth").value=String(new Date().getMonth()+1);
  $("attendanceYear").value=String(currentYear);
  updateAttendanceNav();
  render();
  var authSessionChecked=false;
  async function refreshStorageStatus(){
    try{
      var response=await fetch("/api/health");
      var contentType=response.headers.get("content-type")||"";
      if(!response.ok||!contentType.toLowerCase().includes("application/json")){
        throw new Error("The backend is unavailable.");
      }
      var result=await response.json();
      if(result.status!=="ok"||result.storage!=="sqlite"){
        throw new Error("The portal database is unavailable.");
      }
      applyStorageHealth(result);
      if(!authSessionChecked){
        authSessionChecked=true;
        api("/api/auth/session").then(function(result){return enter(result.user)}).catch(function(error){
          prefillRememberedAccount().catch(function(prefillError){
            console.error("Could not prefill the saved sign-in:",prefillError);
            $("msg").textContent="Could not load the saved sign-in. Enter your account details to continue.";
          });
          if(error.status!==401){
            $("msg").textContent=error.message;
          }
        });
      }
      return result;
    }catch(error){
      $("storageStatus").textContent="Backend not connected. Run start-portal.bat or npm start, then open the address shown in the terminal.";
      return null;
    }
  }
  refreshStorageStatus();
  window.setInterval(function(){
    if(document.visibilityState==="visible")refreshStorageStatus();
  },30000);
})();
