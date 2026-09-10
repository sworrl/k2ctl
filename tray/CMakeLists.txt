cmake_minimum_required(VERSION 3.16)
project(k2ctl-tray VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets Network)
# The webcam window uses WebEngine for the K2's WebRTC stream when available;
# otherwise it falls back to an MJPEG viewer plus "open in browser".
find_package(Qt6 QUIET COMPONENTS WebEngineWidgets)

add_executable(k2ctl-tray
  main.cpp
  client.h client.cpp
  tray.h tray.cpp
  sensorswindow.h sensorswindow.cpp
  sensorgraphic.h sensorgraphic.cpp
  camerawindow.h camerawindow.cpp
  k2ctl-tray.qrc
)
target_link_libraries(k2ctl-tray PRIVATE Qt6::Widgets Qt6::Network)
if(TARGET Qt6::WebEngineWidgets)
  message(STATUS "k2ctl-tray: Qt WebEngine found, WebRTC webcam window enabled")
  target_compile_definitions(k2ctl-tray PRIVATE K2CTL_WEBENGINE=1)
  target_link_libraries(k2ctl-tray PRIVATE Qt6::WebEngineWidgets)
else()
  message(STATUS "k2ctl-tray: Qt WebEngine not found, webcam window is MJPEG-only")
endif()

include(GNUInstallDirs)
install(TARGETS k2ctl-tray RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES k2ctl-tray.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
